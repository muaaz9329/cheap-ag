import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { authHeaders, runningOpencode, type Opencode } from "./opencode.js";
import { NO_SUMMARY } from "./report.js";
import {
  canAlwaysAllow,
  commandPrefix,
  isHardDenied,
  rejectionMessage,
  type Rule,
} from "./permissions.js";
import { modelName, type Limit, type WorkerModel } from "./routing.js";

/** Worker: one OpenCode session for one job, reduced to what the job layer needs. */

export const WORKER_AGENT = "cheapag-worker";
/** How long an aborted prompt may take to go idle before its run is ended anyway. */
const ABORT_GRACE_MS = 10_000;
/** The worker is told not to retry a command the user refused, or a variant of it. */
const REFUSED_MESSAGE = "the user refused this command; don't retry it or a variant";
/** At most this many bash commands are put to the user per job; later asks get the usual rejection. */
const MAX_PERMISSION_ASKS = 3;

/**
 * `repro`: the command that runs the worker's reproduction test, `none: <why>` when it could not reproduce, `n/a` when the step is not a fix.
 * `disagree`: where the step's spec and the source it was given disagree, or `none` (ticket 28: a wrong spec is only visible to whoever has the source).
 */
export type FinishReport = {
  summary: string;
  risks: string[];
  review: string[];
  missing: string[];
  repro?: string;
  disagree?: string;
};
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};
/** What one prompt of a session produced; `limit` when it was aborted on a provider limit, `httpStatus` of a provider error. */
export type RunResult = {
  finish?: FinishReport;
  text: string;
  error?: string;
  limit?: Limit;
  httpStatus?: number;
  interrupted?: boolean;
};
/** Session totals so far: `turns` are model rounds (assistant messages with tool calls), `calls` the tool calls; usage accumulates across every prompt; `spend` is cost per model name. */
export type SessionTotals = {
  sessionID: string;
  turns: number;
  calls: number;
  usage: Usage;
  rejections: Rejection[];
  spend: Record<string, number>;
};
/** A tool call the ruleset denied outright, or a permission request auto-rejected. */
export type Rejection = { kind: "denied" | "asked"; permission: string; what: string };
export type SessionResult = SessionTotals & RunResult;
/** A question the worker asked with OpenCode's question tool: its text and option labels, in order. */
export type Question = { question: string; options: string[] };
/** A bash command the worker asked permission for, put to the user as a BLOCKED block (ticket 69). */
export type PermissionAsk = {
  permission: string;
  command: string;
  title: string;
  why: string;
  prefix: string;
  always: boolean;
};
/** The user's answer: allow once, always allow the prefix this job (and save it), or refuse. */
export type PermissionAnswer = "once" | "always" | "reject";

/** One prompt in flight: how to stop it, and what its events have shown so far. */
type PromptState = {
  /** The model this prompt runs on, when it is not the session's. */
  model?: WorkerModel;
  /** Ends the session (a cap or cancel); none for the prompt after a stop. */
  signal?: AbortSignal;
  /** Aborts the prompt in OpenCode, and drops the event stream if it never goes idle. */
  stop: () => void;
  /** Text part id → its message and latest text. */
  texts: Map<string, PartText>;
  /** Reasoning part id → its message and latest text. */
  reasonings: Map<string, PartText>;
  finish?: FinishReport;
  error?: string;
  httpStatus?: number;
  limit?: Limit;
};
/** The latest text of a text or reasoning part, and the message it belongs to. */
type PartText = { messageID: string; text: string };

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
  /** Called with every event of this session, in order (for the job log and progress); `turns` is the round count. */
  onEvent: (event: Event, turns: number) => void;
  /** Called when the worker asks (one or several questions at once); the session stays paused until it resolves with one answer per question. Without it, questions are rejected. */
  onQuestion?: (questions: Question[]) => Promise<string[]>;
  /** Called when a bash command asks for permission; resolves with the user's answer, or undefined on a stop. Without it (and for non-bash or HARD_DENY), the ask is rejected. */
  onPermission?: (ask: PermissionAsk) => Promise<PermissionAnswer>;
  /** The plan step this prompt is for: the title fallback names it when the bash input has no description. */
  step?: { label: string; title: string };
  /** Aborting it aborts the session's current prompt (OpenCode abort) and refuses later ones: caps and cancel. */
  signal?: AbortSignal;
}) {
  const { opencode, directory } = opts;
  const client = createOpencodeClient({
    baseUrl: opencode.url,
    directory,
    headers: authHeaders(opencode.password),
  });
  const created = await client.session.create({
    directory,
    agent: opts.agent ?? WORKER_AGENT,
    model: { providerID: opts.model.providerID, id: opts.model.id },
    ...(opts.permission && { permission: opts.permission }),
  });
  if (!created.data)
    throw new Error(`could not create a worker session: ${JSON.stringify(created.error)}`);
  let sessionID = created.data.id;
  const calls = new Set<string>();
  const rounds = new Set<string>(); // assistant message ids that carried at least one tool call
  const messages = new Map<string, Usage & { model: string }>(); // assistant message id → its model and latest running totals
  const rejections: Rejection[] = [];
  const toolInputs = new Map<string, Record<string, unknown>>(); // tool call id → its input, to title a bash ask
  let permissionAsks = 0; // a job asks at most MAX_PERMISSION_ASKS times
  const allowedPrefixes = new Set<string>(); // "always allow" prefixes granted this job
  const refusedCommands = new Set<string>(); // the user refused these exact commands; repeats are rejected without asking

  /**
   * `interrupt` ends this prompt only (the session stays usable, e.g. to hand it to another model); `opts.signal` ends the
   * session. `afterStop` runs one more prompt on a stopped session (the findings note), bounded by `interrupt` alone.
   */
  async function run(
    prompt: string,
    model?: WorkerModel,
    interrupt?: AbortSignal,
    afterStop = false,
  ): Promise<RunResult> {
    const signal = afterStop ? undefined : opts.signal;
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
      const current: PromptState = {
        model,
        signal,
        stop,
        texts: new Map(),
        reasonings: new Map(),
      };
      let idle = false;

      const variant = (model ?? opts.model).variant;
      const prompted = await client.session.promptAsync({
        // prompts carry no agent: OpenCode ignores the one given at session.create, and passing ours on each prompt made the worker slower on bug fixes
        sessionID,
        directory,
        parts: [{ type: "text", text: prompt }],
        ...(model && { model: { providerID: model.providerID, modelID: model.id } }),
        ...(variant && { variant }),
      });
      if (prompted.error)
        throw new Error(`could not prompt the worker: ${JSON.stringify(prompted.error)}`);
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
          if (part.type === "tool" && part.state.input && typeof part.state.input === "object")
            toolInputs.set(part.callID, part.state.input as Record<string, unknown>);
          if (
            part.type === "tool" &&
            (part.state.status === "completed" || part.state.status === "error")
          ) {
            // shortcut: OpenCode 1.19's wording for a call its ruleset denied; update if a new pin rewords it
            if (
              !calls.has(part.callID) &&
              part.state.status === "error" &&
              part.state.error.startsWith("The user has specified a rule which prevents")
            ) {
              rejections.push({
                kind: "denied",
                permission: part.tool,
                what: describeCall(part.state.input),
              });
            }
            calls.add(part.callID);
            rounds.add(part.messageID);
            if (part.tool === "finish" && part.state.status === "completed")
              current.finish = asReport(part.state.input);
          }
          if (part.type === "text")
            current.texts.set(part.id, { messageID: part.messageID, text: part.text });
          if (part.type === "reasoning")
            current.reasonings.set(part.id, { messageID: part.messageID, text: part.text });
        } else if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          const { id, cost, tokens, error: failed, providerID, modelID } = event.properties.info;
          // seen live on 1.19.0: some failures (e.g. abort) arrive only on the assistant message, with no session.error
          if (failed) {
            current.error ??= errorMessage(failed);
            current.httpStatus ??= httpStatusOf(failed);
          }
          messages.set(id, {
            model: `${providerID}/${modelID}`,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            reasoningTokens: tokens.reasoning,
            cacheRead: tokens.cache.read,
            cacheWrite: tokens.cache.write,
            costUsd: cost,
          });
        } else if (event.type === "permission.asked") {
          const props = event.properties;
          const what = props.patterns.join(" ") || props.permission;
          const metadata = props.metadata as Record<string, unknown> | undefined;
          const command =
            typeof metadata?.command === "string" && metadata.command.trim()
              ? metadata.command.trim()
              : what;
          const prefix = commandPrefix(command);
          const reject = async (message: string, record = true): Promise<boolean> => {
            if (record) rejections.push({ kind: "asked", permission: props.permission, what });
            const replied = await client.permission
              .reply({ requestID: props.id, directory, reply: "reject", message })
              .catch((err: Error) => ({ error: err.message }));
            if (replied.error) {
              current.error ??= `could not reject a ${props.permission} permission request: ${JSON.stringify(replied.error)}`;
              return false;
            }
            return true;
          };
          const allowOnce = async (): Promise<boolean> => {
            const replied = await client.permission
              .reply({ requestID: props.id, directory, reply: "once" })
              .catch((err: Error) => ({ error: err.message }));
            if (replied.error) {
              current.error ??= `could not answer a ${props.permission} permission request: ${JSON.stringify(replied.error)}`;
              return false;
            }
            return true;
          };
          if (props.permission !== "bash" || !opts.onPermission || isHardDenied(command)) {
            // not askable: the usual rejection
            if (!(await reject(rejectionMessage(what)))) break;
          } else if (refusedCommands.has(command)) {
            // the user already refused this exact command in this job
            if (!(await reject(REFUSED_MESSAGE, false))) break;
          } else {
            const matchesPrefix = command === prefix || command.startsWith(`${prefix} `);
            if (allowedPrefixes.has(prefix) && matchesPrefix) {
              if (!(await allowOnce())) break;
            } else if (permissionAsks >= MAX_PERMISSION_ASKS) {
              if (!(await reject(rejectionMessage(what)))) break;
            } else {
              permissionAsks++;
              opts.onEvent(event, rounds.size); // logged now: the answer may be a long way off
              const call = props.tool?.callID ? toolInputs.get(props.tool.callID) : undefined;
              const description =
                typeof call?.description === "string" && call.description.trim()
                  ? call.description
                  : typeof metadata?.description === "string" && metadata.description.trim()
                    ? metadata.description
                    : undefined;
              const stepTitle = opts.step?.title.trim().slice(0, 60);
              const title =
                description ??
                (opts.step
                  ? `${prefix} for step ${opts.step.label}: ${stepTitle}`
                  : (command.split(/\s+/)[0] ?? command));
              const messageID = props.tool?.messageID;
              const whyText = [...current.texts.values()]
                .filter((t) => t.messageID === messageID)
                .map((t) => t.text)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              const reasoningText = whyText
                ? ""
                : [...current.reasonings.values()]
                    .filter((t) => t.messageID === messageID)
                    .map((t) => t.text)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
              const why = (whyText || reasoningText).slice(0, 200) || "the worker gave no reason";
              const stopped = untilAborted(signal);
              const answer = await Promise.race([
                opts.onPermission({
                  permission: props.permission,
                  command,
                  title,
                  why,
                  prefix,
                  always: canAlwaysAllow(prefix),
                }),
                stopped,
              ]);
              if (answer === undefined) {
                if (!(await reject(rejectionMessage(what), false))) break;
              } else if (answer === "once") {
                if (!(await allowOnce())) break;
              } else if (answer === "always") {
                allowedPrefixes.add(prefix);
                if (!(await allowOnce())) break;
              } else {
                refusedCommands.add(command);
                if (!(await reject(REFUSED_MESSAGE, false))) break;
              }
              continue;
            }
          }
        } else if (event.type === "question.asked") {
          opts.onEvent(event, rounds.size); // logged now: the answer may be a long way off
          const questions = event.properties.questions.map((q) => ({
            question: q.question,
            options: q.options.map((o) => o.label),
          }));
          const requestID = event.properties.id;
          // a stop (cap or cancel) while waiting ends the wait: the question is rejected and the session aborted
          const stopped = untilAborted(signal);
          // a question asked after a stop is never put to Claude: the job is ending, not blocked
          const answers =
            opts.onQuestion && questions.length && !signal?.aborted
              ? await Promise.race([opts.onQuestion(questions), stopped])
              : undefined;
          // nowhere to put the question (a parallel group until early return exists, or the login check): it is rejected, and said so
          if (!opts.onQuestion && questions.length)
            rejections.push({
              kind: "asked",
              permission: "question",
              what: questions.map((q) => q.question).join(" / "),
            });
          const replied = await (
            answers === undefined
              ? client.question.reject({ requestID, directory })
              : client.question.reply({ requestID, directory, answers: answers.map((a) => [a]) })
          ).catch((err: Error) => ({ error: err.message }));
          // an answer that did not go through would leave the session paused forever: end this run as a worker error instead
          if (replied.error) {
            current.error ??= `could not answer the worker's question: ${JSON.stringify(replied.error)}`;
            break;
          }
          continue;
        } else if (event.type === "session.error") {
          current.error = errorMessage(event.properties.error);
          current.httpStatus = httpStatusOf(event.properties.error);
        } else if (
          event.type === "session.status" &&
          event.properties.status.type === "retry" &&
          !current.limit &&
          isLimit(event.properties.status, (model ?? opts.model).providerID)
        ) {
          // a provider limit or rate limit: OpenCode would retry, honouring retry-after, possibly for hours. Stop now, so the
          // job can fall back; this aborts the session directly, not through the job's stop signal (which means a cap)
          const { action, message, next } = event.properties.status;
          current.limit = {
            model: modelName(model ?? opts.model),
            reason: action?.reason,
            message: action?.message ?? message,
            next,
          };
          stop();
        }
        opts.onEvent(event, rounds.size);
        if (event.type === "session.idle") {
          idle = true;
          break;
        }
      }
      if (!idle) current.error ??= "worker event stream ended before the session went idle";
      // the fallback block is read from this prompt's last message only, so a stale one from earlier cannot win
      const last = [...current.texts.values()].at(-1)?.messageID;
      const text = [...current.texts.values()]
        .filter((t) => t.messageID === last)
        .map((t) => t.text)
        .join("\n");
      // an interrupted prompt ends on OpenCode's abort error; that is the hand-over, not a worker failure
      const { finish, error, httpStatus, limit } = current;
      if (interrupt?.aborted && !signal?.aborted) return { finish, text, interrupted: true };
      return { finish, text, error, ...(httpStatus && { httpStatus }), ...(limit && { limit }) };
    } finally {
      signal?.removeEventListener("abort", stop);
      interrupt?.removeEventListener("abort", stop);
      clearTimeout(backstop);
      abort.abort();
    }
  }

  function totals(): SessionTotals {
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    const spend: Record<string, number> = {};
    for (const m of messages.values()) {
      for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += m[key];
      spend[m.model] = (spend[m.model] ?? 0) + m.costUsd;
    }
    return {
      sessionID,
      turns: rounds.size,
      calls: calls.size,
      usage,
      rejections: [...rejections],
      spend,
    };
  }

  /**
   * Moves the session to a fork (new id, same history): OpenCode Go pins a session id to one backend cell, so a fork can
   * land on a healthy one. False, keeping the old id, when the fork fails. The fork's own permission is kept when it
   * has one; otherwise the ruleset is re-applied, so the worker never gets looser rules than the original.
   */
  async function rotate(): Promise<boolean> {
    const forked = await client.session.fork({ sessionID, directory }).catch(() => undefined);
    if (!forked?.data) return false;
    if (opts.permission && !forked.data.permission) {
      const updated = await client.session
        .update({ sessionID: forked.data.id, directory, permission: opts.permission })
        .catch(() => undefined);
      if (!updated?.data) return false;
    }
    sessionID = forked.data.id;
    return true;
  }

  return {
    get sessionID() {
      return sessionID;
    },
    run,
    rotate,
    totals,
  };
}

export type Session = Awaited<ReturnType<typeof openSession>>;

/**
 * Disposes the OpenCode instance for `directory`: nothing it still holds open then keeps the directory from being
 * removed (Windows cannot delete one), and a long-lived server does not keep a watcher per past job. Best effort:
 * no running server, or any error, changes nothing.
 */
export async function releaseDirectory(directory: string) {
  const opencode = await runningOpencode();
  if (!opencode) return;
  try {
    const client = createOpencodeClient({
      baseUrl: opencode.url,
      directory,
      headers: authHeaders(opencode.password),
    });
    await client.instance.dispose({ directory }, { signal: AbortSignal.timeout(10_000) });
  } catch {
    // best effort: a failed dispose must never fail a job
  }
}

/** One prompt in a fresh session (the login live check). */
export async function runSession(
  opts: Parameters<typeof openSession>[0] & { prompt: string },
): Promise<SessionResult> {
  const session = await openSession(opts);
  const result = await session.run(opts.prompt);
  return { ...session.totals(), ...result };
}

/** Resolves with undefined when `signal` aborts, at once if it already has; without a signal, never. */
function untilAborted(signal: AbortSignal | undefined): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve(undefined);
    else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/** OpenCode validates the tool's args, but the record must not trust a malformed one either. */
function asReport(input: Record<string, unknown>): FinishReport {
  const repro = nonBlank(input.repro)?.trim();
  const disagree = nonBlank(input.disagree)?.trim();
  return {
    // oxlint-disable-next-line typescript/no-base-to-string -- a safer cast changes the report text
    summary: String(input.summary ?? ""),
    risks: asList(input.risks),
    review: asList(input.review),
    missing: asList(input.missing),
    ...(repro && { repro }),
    ...(disagree && { disagree }),
  };
}

/** A report list from a tool argument: each item of an array as text, a lone non-empty string, else nothing. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

/** `value` as it is when it is a string with some non-space text; else undefined. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

/**
 * A retry that means a limit, not a blip: a Go account or free-tier limit, any OpenRouter retry (its 429s), or a retry
 * scheduled more than a minute out. A transient 5xx retry on Go or DeepSeek is left to OpenCode's own quick retries.
 */
function isLimit(status: { action?: { reason?: string }; next: number }, providerID: string) {
  return (
    ["account_rate_limit", "free_tier_limit"].includes(status.action?.reason ?? "") ||
    providerID === "openrouter" ||
    status.next - Date.now() > 60_000
  );
}

/** The command or path a tool call targeted, for rejection records. */
function describeCall(input: Record<string, unknown>) {
  return String(
    // oxlint-disable-next-line typescript/no-base-to-string -- a safer cast changes the record text
    input.command ?? input.filePath ?? input.url ?? input.pattern ?? JSON.stringify(input),
  ).slice(0, 200);
}

/** The message of an OpenCode error, else its name. */
function errorMessage(error: unknown) {
  const failure = error as { name?: string; data?: { message?: string } } | undefined;
  return failure?.data?.message ?? failure?.name ?? "unknown worker error";
}

/** The HTTP status of a provider error (APIError), e.g. OpenRouter's 402 for insufficient credits. */
function httpStatusOf(error: unknown) {
  return (error as { data?: { statusCode?: number } } | undefined)?.data?.statusCode;
}

const NO_REPORT: FinishReport = {
  summary: NO_SUMMARY,
  risks: ["worker did not report; review diff"],
  review: [],
  missing: [],
};

/** The finish tool's report; else the last fenced `cheapag-result` block, parsed leniently; else a placeholder. */
export function finishReport(result: Pick<SessionResult, "finish" | "text">): FinishReport {
  if (result.finish) return result.finish;
  const block = [...result.text.matchAll(/```cheapag-result\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block) return NO_REPORT;
  const report: FinishReport = { summary: "", risks: [], review: [], missing: [] };
  let list: ReportList | undefined;
  for (const line of block.split("\n")) {
    const field = line.match(/^(summary|risks|review|missing|repro|disagree):\s*(.*)$/);
    if (field) list = readField(report, field[1] as keyof FinishReport, field[2]);
    else if (list && /^\s*-\s+/.test(line)) report[list].push(line.replace(/^\s*-\s+/, "").trim());
  }
  return { ...report, summary: report.summary || NO_REPORT.summary };
}

/** The report fields a result block writes as lists. */
type ReportList = "risks" | "review" | "missing";

/** Writes one `key: value` line of a result block into `report`; returns the list later `- item` lines add to. */
function readField(
  report: FinishReport,
  key: keyof FinishReport,
  value: string,
): ReportList | undefined {
  if (key === "summary" || key === "repro" || key === "disagree") {
    if (value.trim()) report[key] = value.trim();
    return undefined;
  }
  // inline values: "review: a.ts:1-2, b.ts:3-4"
  const items = value.split(",").map((item) => item.trim());
  if (value.trim()) report[key].push(...items.filter(Boolean));
  return key;
}
