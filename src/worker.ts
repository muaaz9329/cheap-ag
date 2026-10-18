import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import type { Opencode } from "./opencode.js";
import { rejectionMessage, type Rule } from "./permissions.js";
import { modelName, type Limit, type WorkerModel } from "./routing.js";

/** Worker: one OpenCode session for one job, reduced to what the job layer needs. */

export const WORKER_AGENT = "cheapag-worker";
/** How long an aborted prompt may take to go idle before its run is ended anyway. */
const ABORT_GRACE_MS = 10_000;

export type FinishReport = { summary: string; risks: string[]; review: string[]; missing: string[] };
export type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheRead: number; cacheWrite: number; costUsd: number };
/** What one prompt of a session produced; `limit` when it was aborted on a provider limit, `httpStatus` of a provider error. */
export type RunResult = { finish?: FinishReport; text: string; error?: string; limit?: Limit; httpStatus?: number; interrupted?: boolean };
/** Session totals so far: turns and usage accumulate across every prompt of the session; `spend` is cost per model name. */
export type SessionTotals = { sessionID: string; turns: number; usage: Usage; rejections: Rejection[]; spend: Record<string, number> };
/** A tool call the ruleset denied outright, or a permission request auto-rejected. */
export type Rejection = { kind: "denied" | "asked"; permission: string; what: string };
export type SessionResult = SessionTotals & RunResult;
/** A question the worker asked with OpenCode's question tool: its text and option labels, in order. */
export type Question = { question: string; options: string[] };

/**
 * Opens one worker session. `run` prompts it (optionally on another model, e.g. escalation) and resolves when the
 * session goes idle; self-fixes and escalation are further `run`s of the same session.
 */
export async function openSession(opts: {
  opencode: Opencode;
  directory: string;
  model: WorkerModel;
  /** The generated OpenCode agent to run (src/opencode.ts); the implementation worker by default. */
  agent?: string;
  /** The session's permission ruleset (see src/permissions.ts); OpenCode enforces it, last matching rule winning. */
  permission?: Rule[];
  /** Called with every event of this session, in order (for the job log and progress). */
  onEvent: (event: Event, turns: number) => void;
  /** Called when the worker asks (one or several questions at once); the session stays paused until it resolves with one answer per question. Without it, questions are rejected. */
  onQuestion?: (questions: Question[]) => Promise<string[]>;
  /** Aborting it aborts the session's current prompt (OpenCode abort) and refuses later ones: caps and cancel. */
  signal?: AbortSignal;
}) {
  const { opencode, directory } = opts;
  const client = createOpencodeClient({
    baseUrl: opencode.url,
    directory,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}` },
  });
  const created = await client.session.create({
    directory, agent: opts.agent ?? WORKER_AGENT, model: { providerID: opts.model.providerID, id: opts.model.id }, ...(opts.permission && { permission: opts.permission }),
  });
  if (!created.data) throw new Error(`could not create a worker session: ${JSON.stringify(created.error)}`);
  const sessionID = created.data.id;
  const calls = new Set<string>();
  const messages = new Map<string, Usage & { model: string }>(); // assistant message id → its model and latest running totals
  const rejections: Rejection[] = [];

  /** `interrupt` ends this prompt only (the session stays usable, e.g. to hand it to another model); `opts.signal` ends the session. */
  async function run(prompt: string, model?: WorkerModel, interrupt?: AbortSignal): Promise<RunResult> {
    const { signal } = opts;
    if (signal?.aborted) return { text: "", error: "aborted" };
    const abort = new AbortController();
    let backstop: NodeJS.Timeout | undefined;
    const stop = () => {
      void client.session.abort({ sessionID, directory }).catch(() => {});
      // live, an abort ends in session.idle; if it never comes, drop the stream so the run cannot hang
      backstop = setTimeout(() => abort.abort(), ABORT_GRACE_MS);
    };
    // the SDK's stream only connects when first read: wait for server.connected before prompting, or early events are lost
    const { stream } = await client.event.subscribe({ directory }, { signal: abort.signal });
    await stream.next();
    try {
      const texts = new Map<string, { messageID: string; text: string }>(); // text part id → latest text
      let idle = false;
      let finish: FinishReport | undefined;
      let error: string | undefined;
      let httpStatus: number | undefined;
      let limit: Limit | undefined;

      const prompted = await client.session.promptAsync({
        sessionID, directory, parts: [{ type: "text", text: prompt }],
        ...(model && { model: { providerID: model.providerID, modelID: model.id } }),
      });
      if (prompted.error) throw new Error(`could not prompt the worker: ${JSON.stringify(prompted.error)}`);
      // after the prompt, so an abort can never race ahead of it
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      interrupt?.addEventListener("abort", stop, { once: true });
      if (interrupt?.aborted) stop();

      for await (const raw of stream) {
        const event = raw as Event;
        const props = event.properties as { sessionID?: string };
        if (props.sessionID !== sessionID) continue;

        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
            // shortcut: OpenCode 1.19's wording for a call its ruleset denied; update if a new pin rewords it
            if (!calls.has(part.callID) && part.state.status === "error" && part.state.error.startsWith("The user has specified a rule which prevents")) {
              rejections.push({ kind: "denied", permission: part.tool, what: describeCall(part.state.input) });
            }
            calls.add(part.callID);
            if (part.tool === "finish" && part.state.status === "completed") finish = asReport(part.state.input);
          }
          if (part.type === "text") texts.set(part.id, { messageID: part.messageID, text: part.text });
        } else if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          const { id, cost, tokens, error: failed, providerID, modelID } = event.properties.info;
          // seen live on 1.19.0: some failures (e.g. abort) arrive only on the assistant message, with no session.error
          if (failed) {
            error ??= describe(failed);
            httpStatus ??= statusOf(failed);
          }
          messages.set(id, {
            model: `${providerID}/${modelID}`,
            inputTokens: tokens.input, outputTokens: tokens.output, reasoningTokens: tokens.reasoning,
            cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write, costUsd: cost,
          });
        } else if (event.type === "permission.asked") {
          // an unanswered ask blocks forever in server mode: reject every one, with a reason the worker sees
          const what = event.properties.patterns.join(" ") || event.properties.permission;
          rejections.push({ kind: "asked", permission: event.properties.permission, what });
          const replied = await client.permission
            .reply({ requestID: event.properties.id, directory, reply: "reject", message: rejectionMessage(what) })
            .catch((err: Error) => ({ error: err.message }));
          // a reject that did not go through would leave the session blocked: end this run as a worker error instead
          if (replied.error) {
            error ??= `could not reject a ${event.properties.permission} permission request: ${JSON.stringify(replied.error)}`;
            break;
          }
        } else if (event.type === "question.asked") {
          opts.onEvent(event, calls.size); // logged now: the answer may be a long way off
          const questions = event.properties.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label) }));
          const requestID = event.properties.id;
          // a stop (cap or cancel) while waiting ends the wait: the question is rejected and the session aborted
          const stopped = new Promise<undefined>((resolve) => (signal?.aborted ? resolve(undefined) : signal?.addEventListener("abort", () => resolve(undefined), { once: true })));
          // a question asked after a stop is never put to Claude: the job is ending, not blocked
          const answers = opts.onQuestion && questions.length && !signal?.aborted ? await Promise.race([opts.onQuestion(questions), stopped]) : undefined;
          // nowhere to put the question (a parallel group until early return exists, or the login check): it is rejected, and said so
          if (!opts.onQuestion && questions.length) rejections.push({ kind: "asked", permission: "question", what: questions.map((q) => q.question).join(" / ") });
          const replied = await (answers === undefined
            ? client.question.reject({ requestID, directory })
            : client.question.reply({ requestID, directory, answers: answers.map((a) => [a]) })
          ).catch((err: Error) => ({ error: err.message }));
          // an answer that did not go through would leave the session paused forever: end this run as a worker error instead
          if (replied.error) {
            error ??= `could not answer the worker's question: ${JSON.stringify(replied.error)}`;
            break;
          }
          continue;
        } else if (event.type === "session.error") {
          error = describe(event.properties.error);
          httpStatus = statusOf(event.properties.error);
        } else if (event.type === "session.status" && event.properties.status.type === "retry" && !limit && isLimit(event.properties.status, (model ?? opts.model).providerID)) {
          // a provider limit or rate limit: OpenCode would retry, honouring retry-after, possibly for hours. Stop now, so the
          // job can fall back; this aborts the session directly, not through the job's stop signal (which means a cap)
          const { action, message, next } = event.properties.status;
          limit = { model: modelName(model ?? opts.model), reason: action?.reason, message: action?.message ?? message, next };
          stop();
        }
        opts.onEvent(event, calls.size);
        if (event.type === "session.idle") {
          idle = true;
          break;
        }
      }
      if (!idle) error ??= "worker event stream ended before the session went idle";
      // the fallback block is read from this prompt's last message only, so a stale one from earlier cannot win
      const last = [...texts.values()].at(-1)?.messageID;
      const text = [...texts.values()].filter((t) => t.messageID === last).map((t) => t.text).join("\n");
      // an interrupted prompt ends on OpenCode's abort error; that is the hand-over, not a worker failure
      if (interrupt?.aborted && !signal?.aborted) return { finish, text, interrupted: true };
      return { finish, text, error, ...(httpStatus && { httpStatus }), ...(limit && { limit }) };
    } finally {
      opts.signal?.removeEventListener("abort", stop);
      interrupt?.removeEventListener("abort", stop);
      clearTimeout(backstop);
      abort.abort();
    }
  }

  function totals(): SessionTotals {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    const spend: Record<string, number> = {};
    for (const m of messages.values()) {
      for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += m[key];
      spend[m.model] = (spend[m.model] ?? 0) + m.costUsd;
    }
    return { sessionID, turns: calls.size, usage, rejections: [...rejections], spend };
  }

  return { sessionID, run, totals };
}

export type Session = Awaited<ReturnType<typeof openSession>>;

/** One prompt in a fresh session (the login live check). */
export async function runSession(opts: Parameters<typeof openSession>[0] & { prompt: string }): Promise<SessionResult> {
  const session = await openSession(opts);
  const result = await session.run(opts.prompt);
  return { ...session.totals(), ...result };
}

/** OpenCode validates the tool's args, but the record must not trust a malformed one either. */
function asReport(input: Record<string, unknown>): FinishReport {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  return { summary: String(input.summary ?? ""), risks: list(input.risks), review: list(input.review), missing: list(input.missing) };
}

/**
 * A retry that means a limit, not a blip: a Go account or free-tier limit, any OpenRouter retry (its 429s), or a retry
 * scheduled more than a minute out. A transient 5xx retry on Go or DeepSeek is left to OpenCode's own quick retries.
 */
function isLimit(status: { action?: { reason?: string }; next: number }, providerID: string) {
  return ["account_rate_limit", "free_tier_limit"].includes(status.action?.reason ?? "") || providerID === "openrouter" || status.next - Date.now() > 60_000;
}

/** The command or path a tool call targeted, for rejection records. */
function describeCall(input: Record<string, unknown>) {
  return String(input.command ?? input.filePath ?? input.url ?? input.pattern ?? JSON.stringify(input)).slice(0, 200);
}

function describe(err: unknown) {
  const e = err as { name?: string; data?: { message?: string } } | undefined;
  return e?.data?.message ?? e?.name ?? "unknown worker error";
}

/** The HTTP status of a provider error (APIError), e.g. OpenRouter's 402 for insufficient credits. */
const statusOf = (err: unknown) => (err as { data?: { statusCode?: number } } | undefined)?.data?.statusCode;

const NO_REPORT: FinishReport = { summary: "(worker gave no summary)", risks: ["worker did not report; review diff"], review: [], missing: [] };

/** The finish tool's report; else the last fenced `cheapag-result` block, parsed leniently; else a placeholder. */
export function finishReport(result: Pick<SessionResult, "finish" | "text">): FinishReport {
  if (result.finish) return result.finish;
  const block = [...result.text.matchAll(/```cheapag-result\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block) return NO_REPORT;
  const report: FinishReport = { summary: "", risks: [], review: [], missing: [] };
  let list: "risks" | "review" | "missing" | undefined;
  for (const line of block.split("\n")) {
    const kv = line.match(/^(summary|risks|review|missing):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (key === "summary") {
        report.summary = value.trim();
        list = undefined;
      } else {
        list = key as typeof list;
        // inline values: "review: a.ts:1-2, b.ts:3-4"
        if (value.trim()) report[list!].push(...value.split(",").map((v) => v.trim()).filter(Boolean));
      }
    } else if (list && /^\s*-\s+/.test(line)) {
      report[list].push(line.replace(/^\s*-\s+/, "").trim());
    }
  }
  return { ...report, summary: report.summary || NO_REPORT.summary };
}
