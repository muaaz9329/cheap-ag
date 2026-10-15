import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import type { Opencode } from "./opencode.js";

/** Worker: one OpenCode session for one job, reduced to what the job layer needs. */

export const WORKER_AGENT = "cheapag-worker";

export type FinishReport = { summary: string; risks: string[]; review: string[]; missing: string[] };
export type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheRead: number; cacheWrite: number; costUsd: number };
export type SessionResult = { sessionID: string; turns: number; usage: Usage; finish?: FinishReport; text: string; error?: string };

export async function runSession(opts: {
  opencode: Opencode;
  directory: string;
  model: { providerID: string; id: string };
  prompt: string;
  /** Called with every event of this session, in order (for the job log and progress). */
  onEvent: (event: Event, turns: number) => void;
}): Promise<SessionResult> {
  const { opencode, directory } = opts;
  const client = createOpencodeClient({
    baseUrl: opencode.url,
    directory,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}` },
  });
  const abort = new AbortController();
  // the SDK's stream only connects when first read: wait for server.connected before prompting, or early events are lost
  const { stream } = await client.event.subscribe({ directory }, { signal: abort.signal });
  await stream.next();

  try {
    const created = await client.session.create({ directory, agent: WORKER_AGENT, model: opts.model });
    if (!created.data) throw new Error(`could not create a worker session: ${JSON.stringify(created.error)}`);
    const sessionID = created.data.id;

    const calls = new Set<string>();
    const messages = new Map<string, Usage>(); // assistant message id → its latest running totals
    const texts = new Map<string, { messageID: string; text: string }>(); // text part id → latest text
    let idle = false;
    let finish: FinishReport | undefined;
    let error: string | undefined;

    const prompted = await client.session.promptAsync({ sessionID, directory, parts: [{ type: "text", text: opts.prompt }] });
    if (prompted.error) throw new Error(`could not prompt the worker: ${JSON.stringify(prompted.error)}`);

    for await (const raw of stream) {
      const event = raw as Event;
      const props = event.properties as { sessionID?: string };
      if (props.sessionID !== sessionID) continue;

      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
          calls.add(part.callID);
          if (part.tool === "finish" && part.state.status === "completed") finish = asReport(part.state.input);
        }
        if (part.type === "text") texts.set(part.id, { messageID: part.messageID, text: part.text });
      } else if (event.type === "message.updated" && event.properties.info.role === "assistant") {
        const { id, cost, tokens } = event.properties.info;
        messages.set(id, {
          inputTokens: tokens.input, outputTokens: tokens.output, reasoningTokens: tokens.reasoning,
          cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write, costUsd: cost,
        });
      } else if (event.type === "session.error") {
        const err = event.properties.error as { name?: string; data?: { message?: string } } | undefined;
        error = err?.data?.message ?? err?.name ?? "unknown worker error";
      }
      opts.onEvent(event, calls.size);
      if (event.type === "session.idle") {
        idle = true;
        break;
      }
    }
    if (!idle) error ??= "worker event stream ended before the session went idle";

    const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    for (const m of messages.values()) for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += m[key];
    // the fallback block is read from the last message only, so a stale one from earlier cannot win
    const last = [...texts.values()].at(-1)?.messageID;
    const text = [...texts.values()].filter((t) => t.messageID === last).map((t) => t.text).join("\n");
    return { sessionID, turns: calls.size, usage, finish, text, error };
  } finally {
    abort.abort();
  }
}

/** OpenCode validates the tool's args, but the record must not trust a malformed one either. */
function asReport(input: Record<string, unknown>): FinishReport {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  return { summary: String(input.summary ?? ""), risks: list(input.risks), review: list(input.review), missing: list(input.missing) };
}

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
