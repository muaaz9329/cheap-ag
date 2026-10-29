import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { consentGate } from "./consent.js";
import { redact, type Provider } from "./credentials.js";
import { records } from "./jobs.js";
import { holdOpencode, type Opencode } from "./opencode.js";
import { projectScripts, researchRuleset } from "./permissions.js";
import { normalisePath } from "./platform.js";
import { failBlock, renderResearch, type ResearchRecord } from "./report.js";
import { chain, modelName, recordSpend, runRouted, type Route } from "./routing.js";
import { openSession, releaseDirectory, type Session } from "./worker.js";
import { createWorktree, projectRoot, removeWorktree, type Worktree } from "./workspace.js";

/**
 * Research: one question about the codebase, answered by a worker that reads, searches and runs test commands but
 * never edits (agent `cheapag-research`, ruleset `researchRuleset`), in a throwaway worktree of the developer's current
 * state (uncommitted work included) so a command can't touch their tree. It runs alongside jobs. The worker reports a
 * scout brief (ticket 23.4) in a fenced `cheapag-research` block in its final text; a claimed reproduction is checked
 * against the commands it actually ran.
 */

export const RESEARCH_AGENT = "cheapag-research";
export const MAX_WORDS = 600;
const DEFAULT_WORDS = 200;
/** At most this many refs: the refs line must stay within the 200-char line rule. */
const MAX_REFS = 5;

export type ResearchInput = { question: string; paths?: string; max_words?: number };
type Answer = Pick<ResearchRecord, "status" | "answer" | "refs" | "confidence" | "repro" | "deadEnds">;

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
    const rel = normalisePath(relative(root, join(root, path)));
    if (isAbsolute(path) || rel === ".." || rel.startsWith("../")) return failBlock(`path ${path} must be inside the repository, relative to its root`);
    if (!existsSync(join(root, path))) return failBlock(`path ${path} not found`);
    if (rel) scope.push(rel); // "." is the whole repo: no scope
  }
  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  const { limits } = config;
  const maxWords = Math.min(input.max_words ?? DEFAULT_WORDS, MAX_WORDS);

  const opencode = await ctx.opencode(gate.route);
  const release = holdOpencode();
  const { id, dir } = newResearch(root);
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"));
  // the research model, then its fallbacks, each only if the repo's allowlist kept it (src/consent.ts)
  const models = chain(gate.route.research ?? gate.route.implement, gate.route.researchFallbacks);
  const startedAt = new Date();
  write("request.json", { ...input, scope, maxWords, models: [models.first, ...models.rest].map(modelName), startedAt });

  const prompt = [
    `Question: ${input.question}`,
    scope.length && `Scope: look only under ${scope.join(", ")}; cite only files there.`,
    REPRO_RULE,
    `Answer in at most ${maxWords} words.`,
    // repeated here because real models skipped the agent prompt's format (seen live): without it a right answer is UNSURE
    BRIEF_FORMAT,
  ].filter(Boolean).join("\n");
  const files = new Set<string>();
  const ran: string[] = []; // the commands the worker actually ran: a claimed reproduction must be one of them
  const spent = { turns: 0, costUsd: 0 };
  let text = "";
  let error: string | undefined;
  let budget: string | undefined;
  // set from event callbacks: keep TS from narrowing it to undefined
  let stopped = undefined as { status: "FAIL" | "BUDGET"; reason: string } | undefined;
  let worktree: Worktree | undefined;
  try {
    worktree = createWorktree(root, id, config.link_dirs);
    const { scripts, exact } = projectScripts(worktree.path);
    const permission = researchRuleset({ scripts, exact: [...exact, ...(config.test_cmd ? [config.test_cmd] : [])], allowCommands: config.allow_commands });
    const halt = new AbortController();
    const stop = (why: NonNullable<typeof stopped>) => {
      stopped ??= why;
      halt.abort();
    };
    const timer = setTimeout(() => stop({ status: "FAIL", reason: `minute cap (${limits.max_minutes} min) reached` }), limits.max_minutes * 60_000);
    const session: Session = await openSession({
      opencode, directory: worktree.path, model: models.first, agent: RESEARCH_AGENT, permission, signal: halt.signal,
      onEvent: (event, turns) => {
        appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
        if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
          const { tool, state } = event.properties.part;
          if (state.status === "completed" && tool === "read") files.add(String(state.input.filePath));
          if (state.status === "completed" && tool === "bash") ran.push(String(state.input.command ?? ""));
          if (state.status === "completed" || state.status === "error") {
            ctx.progress(turns, `turn ${turns}: ${tool}`);
            if (turns >= limits.max_turns) stop({ status: "FAIL", reason: `turn cap (${limits.max_turns}) reached` });
          }
        }
        if (event.type === "message.updated" && session.totals().usage.costUsd >= limits.max_cost_usd) {
          stop({ status: "BUDGET", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
        }
      },
    });
    try {
      // a provider limit continues the same session on the next fallback (src/routing.ts), never waiting it out
      ({ text, error, budget } = await runRouted(session, prompt, models, ctx.provider.provider));
    } finally {
      clearTimeout(timer);
      const totals = session.totals();
      spent.turns = totals.turns;
      spent.costUsd = totals.usage.costUsd;
      try {
        recordSpend(totals.spend); // research draws on the same Go windows as jobs
      } catch {
        // the ledger only steers later escalations: never fail an answer over it
      }
    }
  } catch (err) {
    error = (err as Error).message;
  } finally {
    release(); // the session is done: a config change may reboot OpenCode now
    if (worktree) {
      await releaseDirectory(worktree.path); // release before the worktree is removed
      removeWorktree(root, worktree);
    }
  }

  const answer: Answer = stopped ? { status: stopped.status, answer: "", refs: [] }
    : budget ? { status: "BUDGET", answer: "", refs: [] }
    : error ? { status: "FAIL", answer: "", refs: [] }
    : verifyRepro(parseAnswer(text, root, scope, maxWords), ran) ?? { status: "FAIL", answer: "", refs: [] };
  const reason = stopped?.reason
    ?? budget
    ?? (error ? `worker error: ${error}` : answer.status === "FAIL" ? "the research worker gave no answer" : undefined);
  const final = models.current;
  const record = {
    format: "cheapag/1" as const, job: id, kind: "research", provider: ctx.provider.provider, question: input.question, scope,
    ...answer, reason, filesRead: files.size, unlanded: unlandedJobs(root),
    models: { requested: modelName(models.first), final: modelName(final) },
    usage: spent,
    timing: { startedAt, endedAt: new Date(), ms: Date.now() - startedAt.getTime() },
  };
  const block = renderResearch(record);
  // research.json, not result.json: `jobs list` reads only job records
  write("research.json", record);
  write("result.txt", block + "\n");
  return block;
}

/** Research verifies before it claims (ticket 23.4: unverified handoffs inject false confidence). */
export const REPRO_RULE = "If the question is about a failure or wrong behaviour, reproduce it: run the relevant test or command and report exactly what it showed. Never claim a reproduction you did not run.";
export const BRIEF_FORMAT = "End your reply with exactly one fenced ```cheapag-research block: status (answer or unsure), confidence (high, medium or low), files (path:start-end, most relevant first, comma-separated), repro (`command` → what it showed, or not attempted), dead ends (what you ruled out, or none), then notes: and your prose.";

/**
 * A claimed reproduction stands only if its `command` is one the worker ran; otherwise it is marked unverified and the
 * confidence drops to low, so Claude doesn't build on a guess.
 */
export function verifyRepro(answer: Answer | undefined, ran: string[]): Answer | undefined {
  const repro = answer?.repro?.trim();
  if (!answer || !repro || /^not attempted|^none$/i.test(repro)) return answer && { ...answer, repro: repro || undefined };
  const norm = (c: string) => c.replace(/\s+/g, " ").trim();
  const claimed = norm(repro.match(/`([^`]+)`/)?.[1] ?? "");
  const verified = !!claimed && ran.some((c) => norm(c).includes(claimed) || claimed.includes(norm(c)));
  return verified ? { ...answer, repro } : { ...answer, repro: `unverified (not run): ${repro}`, confidence: "low" };
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
    const kv = line.match(/^\s*(status|confidence|refs|files|repro|dead[ _]ends|answer|notes):\s*(.*)$/i);
    // files/notes are the brief's names (ticket 23.4); refs/answer still read
    if (kv) fields[(key = ({ files: "refs", notes: "answer", "dead ends": "deadEnds", dead_ends: "deadEnds" } as Record<string, string>)[kv[1].toLowerCase()] ?? kv[1].toLowerCase())] = kv[2];
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
    repro: fields.repro?.trim() || undefined,
    deadEnds: fields.deadEnds?.trim() && !/^none\.?$/i.test(fields.deadEnds.trim()) ? fields.deadEnds.trim() : undefined,
  };
}

/** The raw `path:line(-line)` candidates in text, before validation. Accepts a Windows drive letter and backslashes. */
export function refTokens(text: string): { path: string; from: string; to: string | undefined }[] {
  return [...text.matchAll(/((?:[A-Za-z]:)?[\w./\\@-]+):(\d+)(?:-(\d+))?/g)].map(([, path, from, to]) => ({ path, from, to }));
}

/**
 * Validated `path:line(-line)` refs from free text, at most 5: the file exists in the main checkout, inside the repo
 * (and the scope, when there is one), and has those lines. Absolute paths inside the repo are made relative.
 */
function refs(text: string, root: string, scope: string[]): ResearchRecord["refs"] {
  const out: ResearchRecord["refs"] = [];
  for (const { path, from, to } of refTokens(text)) {
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
