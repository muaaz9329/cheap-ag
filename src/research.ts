import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig, type Limits } from "./config.js";
import { consentGate } from "./consent.js";
import { redact, type Provider } from "./credentials.js";
import { records } from "./jobs.js";
import { holdOpencode, type Opencode } from "./opencode.js";
import { researchRuleset } from "./permissions.js";
import { normalisePath } from "./platform.js";
import { failBlock, renderResearch, type ResearchRecord } from "./report.js";
import { modelName, type Route, type WorkerModel } from "./routing.js";
import { openSession, type Session } from "./worker.js";
import { projectRoot } from "./workspace.js";

/**
 * Research: one question about the codebase, answered by a strictly read-only worker (agent `cheapag-research`, ruleset
 * `researchRuleset`) in the main checkout itself, uncommitted work included; no worktree, nothing written outside
 * `.cheapag/`. It runs alongside jobs. The worker reports in a fenced `cheapag-research` block in its final text.
 */

export const RESEARCH_AGENT = "cheapag-research";
export const MAX_WORDS = 600;
const DEFAULT_WORDS = 200;
/** At most this many refs: the refs line must stay within the 200-char line rule. */
const MAX_REFS = 5;
// retry reasons that mean the model's Go (or free-tier) allowance is used up (spec: Go-limit detection)
const LIMIT_REASONS = ["account_rate_limit", "free_tier_limit"];

export type ResearchInput = { question: string; paths?: string; max_words?: number };
type Answer = Pick<ResearchRecord, "status" | "answer" | "refs" | "confidence">;

export async function research(
  input: ResearchInput,
  ctx: { provider: Provider; opencode: (route: Route) => Promise<Opencode>; progress: (turns: number, message: string) => void },
): Promise<string> {
  const root = projectRoot(process.cwd());
  // first: an unapproved repo gets CONSENT before any record, OpenCode boot or provider call
  const gate = consentGate(root, ctx.provider.provider);
  if ("block" in gate) return gate.block;
  const scope: string[] = [];
  for (const path of (input.paths ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const rel = relative(root, join(root, path));
    if (isAbsolute(path) || rel === ".." || rel.startsWith("../")) return failBlock(`path ${path} must be inside the repository, relative to its root`);
    if (!existsSync(join(root, path))) return failBlock(`path ${path} not found`);
    if (rel) scope.push(normalisePath(rel)); // "." is the whole repo: no scope
  }
  let limits: Limits;
  try {
    limits = loadConfig(root).limits;
  } catch (err) {
    return failBlock((err as Error).message);
  }
  const maxWords = Math.min(input.max_words ?? DEFAULT_WORDS, MAX_WORDS);

  const opencode = await ctx.opencode(gate.route);
  const release = holdOpencode();
  const { id, dir } = newResearch(root);
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"));
  // the research model, then its fallback, the implement model; each only if the repo's allowlist kept it
  const chain = [gate.route.research, gate.route.implement].filter((m, i, all): m is WorkerModel => !!m && all.findIndex((o) => o && modelName(o) === modelName(m)) === i);
  const startedAt = new Date();
  write("request.json", { ...input, scope, maxWords, models: chain.map(modelName), startedAt });

  const prompt = [
    `Question: ${input.question}`,
    scope.length && `Scope: look only under ${scope.join(", ")}; cite only files there.`,
    `Answer in at most ${maxWords} words.`,
    // repeated here because real models skipped the agent prompt's format (seen live): without it a right answer is UNSURE
    "End your reply with exactly one fenced ```cheapag-research block: status (answer or unsure), confidence (high, medium or low), refs (path:line, comma-separated), then answer: and your prose.",
  ].filter(Boolean).join("\n");
  const files = new Set<string>();
  const spent = { turns: 0, costUsd: 0 };
  let final = chain[0];
  let text = "";
  let error: string | undefined;
  // set from event callbacks: keep TS from narrowing them to undefined
  let stopped = undefined as { status: "FAIL" | "BUDGET"; reason: string } | undefined;
  let limited = undefined as string | undefined;
  try {
    // a Go limit on one model aborts its session and asks the next in a fresh one; caps count across both
    for (const model of chain) {
      final = model;
      limited = undefined;
      const halt = new AbortController();
      const stop = (why: NonNullable<typeof stopped>) => {
        stopped ??= why;
        halt.abort();
      };
      const timer = setTimeout(() => stop({ status: "FAIL", reason: `minute cap (${limits.max_minutes} min) reached` }), Math.max(0, startedAt.getTime() + limits.max_minutes * 60_000 - Date.now()));
      const session: Session = await openSession({
        opencode, directory: root, model, agent: RESEARCH_AGENT, permission: researchRuleset(), signal: halt.signal,
        onEvent: (event, turns) => {
          appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
          if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
            const { tool, state } = event.properties.part;
            if (state.status === "completed" && tool === "read") files.add(String(state.input.filePath));
            if (state.status === "completed" || state.status === "error") {
              ctx.progress(spent.turns + turns, `turn ${spent.turns + turns}: ${tool}`);
              if (spent.turns + turns >= limits.max_turns) stop({ status: "FAIL", reason: `turn cap (${limits.max_turns}) reached` });
            }
          }
          if (event.type === "message.updated" && spent.costUsd + session.totals().usage.costUsd >= limits.max_cost_usd) {
            stop({ status: "BUDGET", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
          }
          if (event.type === "session.status" && event.properties.status.type === "retry") {
            const { action } = event.properties.status;
            if (action && LIMIT_REASONS.includes(action.reason)) {
              limited = `${modelName(model)}: ${action.message}`;
              halt.abort();
            }
          }
        },
      });
      try {
        ({ text, error } = await session.run(prompt));
      } finally {
        clearTimeout(timer);
        const totals = session.totals();
        spent.turns += totals.turns;
        spent.costUsd += totals.usage.costUsd;
      }
      if (!limited || stopped) break;
    }
  } catch (err) {
    error = (err as Error).message;
  } finally {
    release(); // the session is done: a config change may reboot OpenCode now
  }

  const answer: Answer = stopped ? { status: stopped.status, answer: "", refs: [] }
    : limited ? { status: "BUDGET", answer: "", refs: [] }
    : error ? { status: "FAIL", answer: "", refs: [] }
    : parseAnswer(text, root, scope, maxWords) ?? { status: "FAIL", answer: "", refs: [] };
  const reason = stopped?.reason
    ?? (limited ? `usage limit reached on every allowed research model (${limited})` : undefined)
    ?? (error ? `worker error: ${error}` : answer.status === "FAIL" ? "the research worker gave no answer" : undefined);
  const record = {
    format: "cheapag/1" as const, job: id, kind: "research", provider: ctx.provider.provider, question: input.question, scope,
    ...answer, reason, filesRead: files.size, unlanded: unlandedJobs(root),
    models: { requested: modelName(chain[0]), final: modelName(final) },
    usage: spent,
    timing: { startedAt, endedAt: new Date(), ms: Date.now() - startedAt.getTime() },
  };
  const block = renderResearch(record);
  // research.json, not result.json: `jobs list` reads only job records
  write("research.json", record);
  write("result.txt", block + "\n");
  return block;
}

/**
 * Jobs whose changes research cannot see (D7 note): not landed, and either still in flight (RUNNING or BLOCKED: their
 * changes may land later) or holding changes in a worktree that still exists (PARTIAL, FAIL, CONFLICT, TIMEOUT,
 * BUDGET, CANCELLED with edits; `land apply` could still land them). A discarded or cleaned-up job, or one that changed
 * nothing, has nothing to miss. Oldest first.
 */
export function unlandedJobs(root: string): string[] {
  return records(root)
    .filter((r) => !r.landed && (r.status === "RUNNING" || r.status === "BLOCKED" || (!!r.worktree && !!r.changed?.length && existsSync(join(root, r.worktree)))))
    .sort((a, b) => String(a.timing?.startedAt ?? "").localeCompare(String(b.timing?.startedAt ?? "")))
    .map((r) => r.job);
}

/**
 * The worker's last fenced `cheapag-research` block, parsed leniently. Without one, its final text is the answer,
 * UNSURE with low confidence (the worker never rated it). Nothing at all → undefined.
 */
export function parseAnswer(text: string, root: string, scope: string[], maxWords: number): Answer | undefined {
  const block = [...text.matchAll(/```cheapag-research[^\n]*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block) return text.trim() ? { status: "UNSURE", answer: capWords(text.trim(), maxWords), refs: refs(text, root, scope), confidence: "low" } : undefined;
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block.split("\n")) {
    const kv = line.match(/^\s*(status|confidence|refs|answer):\s*(.*)$/i);
    if (kv) fields[(key = kv[1].toLowerCase())] = kv[2];
    else if (key === "answer") fields.answer += `\n${line}`; // the answer is prose: it may span lines
  }
  const answer = (fields.answer ?? "").trim();
  if (!answer) return undefined;
  const listed = refs(fields.refs ?? "", root, scope);
  const confidence = fields.confidence?.trim().toLowerCase().match(/^(high|medium|low)/)?.[1] as Answer["confidence"];
  return {
    status: /^unsure/i.test(fields.status?.trim() ?? "") ? "UNSURE" : "ANSWER",
    answer: capWords(answer, maxWords),
    // refs from the refs line; failing that, any cited in the prose
    refs: listed.length ? listed : refs(answer, root, scope),
    confidence: confidence ?? "low",
  };
}

/**
 * Validated `path:line(-line)` refs from free text, at most 5: the file exists in the main checkout, inside the repo
 * (and the scope, when there is one), and has those lines. Absolute paths inside the repo are made relative.
 */
function refs(text: string, root: string, scope: string[]): ResearchRecord["refs"] {
  const out: ResearchRecord["refs"] = [];
  for (const [, path, from, to] of text.matchAll(/([\w./@-]+):(\d+)(?:-(\d+))?/g)) {
    const abs = isAbsolute(path) ? path : join(root, path);
    const rel = normalisePath(relative(root, abs));
    const start = Number(from);
    const end = Number(to ?? from);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || start < 1 || end < start) continue;
    if (scope.length && !scope.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
    if (out.some((r) => r.path === rel && r.start === start && r.end === end)) continue;
    try {
      if (!statSync(abs).isFile()) continue;
      const content = readFileSync(abs, "utf8");
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      if (end > lines) continue;
    } catch {
      continue; // no such file
    }
    out.push({ path: rel, start, end });
    if (out.length === MAX_REFS) break;
  }
  return out;
}

/** The text cut after `max` words, line breaks kept. */
function capWords(text: string, max: number) {
  const words = [...text.matchAll(/\S+/g)];
  return words.length <= max ? text : `${text.slice(0, words[max].index).trimEnd()} …`;
}

/** A fresh `r` + 4 base36 id whose folder (beside the job folders, D7 `log:`) does not exist yet. */
function newResearch(root: string) {
  for (;;) {
    const id = `r${randomBytes(4).readUInt32BE().toString(36).slice(-4).padStart(4, "0")}`;
    const dir = join(root, ".cheapag", "jobs", id);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    return { id, dir };
  }
}
