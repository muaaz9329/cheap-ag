import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Event, type ToolPart } from "@opencode-ai/sdk/v2";
import { isAbsolute, basename, join, relative } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { consentGate } from "./consent.js";
import { redact, type Provider } from "./credentials.js";
import { gzipEvents, newId, records } from "./jobs.js";
import { holdOpencode, type Opencode } from "./opencode.js";
import { projectScripts, researchRuleset } from "./permissions.js";
import { normalisePath } from "./platform.js";
import { failBlock, renderResearch, type ResearchRecord } from "./report.js";
import { chain, modelName, recordSpend, runRouted, type Chain, type Route } from "./routing.js";
import { openSession, releaseDirectory, type Session } from "./worker.js";
import {
  callRoot,
  createWorktree,
  git,
  hasCommits,
  removeWorktree,
  type Worktree,
} from "./workspace.js";
import { checkAllows } from "./verify.js";

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

export type ResearchInput = { question: string; paths?: string; max_words?: number; root?: string };
type Answer = Pick<
  ResearchRecord,
  "status" | "answer" | "refs" | "confidence" | "repro" | "deadEnds" | "partial"
>;

export async function research(
  input: ResearchInput,
  ctx: {
    provider: Provider;
    opencode: (route: Route) => Promise<Opencode>;
    progress: (turns: number, message: string) => void;
  },
): Promise<string> {
  const root = callRoot(input.root);
  // first: an unapproved repo gets CONSENT before any record, OpenCode boot or provider call
  const gate = consentGate(root, ctx.provider.provider);
  if ("block" in gate) return gate.block;
  const resolved = resolveScope(root, input.paths ?? "");
  if ("block" in resolved) return resolved.block;
  const { scope, resolvedPaths } = resolved;
  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  if (!hasCommits(root))
    return failBlock(
      `this repository has no commits yet, and Cheap Agent starts each job from the last commit. Make a first commit, then research again: git add -A && git commit -m "start"`,
    );
  const maxWords = Math.min(input.max_words ?? DEFAULT_WORDS, MAX_WORDS);

  const opencode = await ctx.opencode(gate.route);
  const release = holdOpencode();
  const { id, directory } = newResearch(root);
  // the research model, then its fallbacks, each only if the repo's allowlist kept it (src/consent.ts)
  const models = chain(gate.route.research ?? gate.route.implement, gate.route.researchFallbacks);
  const startedAt = new Date();
  writeLog(directory, "request.json", {
    ...input,
    scope,
    maxWords,
    models: [models.first, ...models.rest].map(modelName),
    startedAt,
  });

  const prompt = researchPrompt(input.question, scope, maxWords);
  let run: WorkerRun;
  try {
    run = await runWorker({ root, id, directory, config, opencode, models, prompt, ctx });
  } finally {
    release(); // the session is done: a config change may reboot OpenCode now
  }

  const parse = (text: string) => verifyRepro(parseAnswer(text, root, scope, maxWords), run.ran);
  let answer = workerAnswer(run, parse);
  // a path resolved by basename says so in the notes, so Claude learns the entry was approximate
  if (resolvedPaths.length)
    answer = { ...answer, answer: [...resolvedPaths, answer.answer].filter(Boolean).join("\n") };
  const reason = failureReason(run, answer.status);
  const final = models.current;
  const record = {
    format: "cheapag/1" as const,
    job: id,
    kind: "research",
    provider: ctx.provider.provider,
    question: input.question,
    scope,
    ...answer,
    reason,
    filesRead: run.files.size,
    unlanded: unlandedJobs(root),
    models: { requested: modelName(models.first), final: modelName(final) },
    usage: run.spent,
    timing: { startedAt, endedAt: new Date(), ms: Date.now() - startedAt.getTime() },
    cleanupError: undefined as string | undefined,
    worktree: undefined as string | undefined,
  };
  let block = "";
  const save = () => {
    block = renderResearch(record);
    // research.json, not result.json: `jobs list` reads only job records
    writeLog(directory, "research.json", record);
    writeLog(directory, "result.txt", block + "\n");
  };
  save();
  if (run.worktree) {
    try {
      await releaseDirectory(run.worktree.path); // release before the worktree is removed
      removeWorktree(root, run.worktree);
    } catch (err) {
      // Cleanup failure must not replace the worker's answer or its original error.
      record.cleanupError = (err as Error).message;
      record.worktree = normalisePath(relative(root, run.worktree.path));
      save();
    }
  }
  if (answer.status === "ANSWER") gzipEvents(directory);
  return block;
}

/** A cap that stopped the worker early, and the status it gives the answer. */
type Stop = { status: "FAIL" | "BUDGET"; reason: string; cap?: "turns" };

/** What one research run needs once its inputs are checked. */
type WorkerJob = {
  root: string;
  id: string;
  /** The research log folder. */
  directory: string;
  config: Config;
  opencode: Opencode;
  models: Chain;
  prompt: string;
  ctx: Parameters<typeof research>[1];
};

/** What the worker left behind: its reply or error, the cap that stopped it, and what it read, ran and spent. */
type WorkerRun = {
  text: string;
  error?: string;
  budget?: string;
  providerDown?: string;
  stopped?: Stop;
  partialText: string;
  worktree?: Worktree;
  files: Set<string>;
  /** The commands the worker actually ran: a claimed reproduction must be one of them. */
  ran: string[];
  spent: { turns: number; calls: number; costUsd: number };
};

/** Runs the worker in a throwaway worktree. Any error is kept in the run, not thrown, so the record still gets written. */
async function runWorker(job: WorkerJob): Promise<WorkerRun> {
  const run: WorkerRun = {
    text: "",
    partialText: "",
    files: new Set<string>(),
    ran: [],
    spent: { turns: 0, calls: 0, costUsd: 0 },
  };
  try {
    run.worktree = createWorktree(job.root, job.id, job.config.link_dirs);
    await askWorker(job, run, run.worktree.path);
  } catch (error) {
    run.error = (error as Error).message;
  }
  return run;
}

/** Asks the question in a read-only session in `directory`, under the run's caps, and records what the session spent. */
async function askWorker(job: WorkerJob, run: WorkerRun, directory: string) {
  const permission = researchPermission(directory, job.config);
  const caps = startCaps(run, job.config.limits);
  const watch: EventWatch = { job, run, stop: caps.stop, totals: () => session.totals() };
  const session: Session = await openSession({
    opencode: job.opencode,
    directory,
    model: job.models.first,
    agent: RESEARCH_AGENT,
    permission,
    signal: caps.signal,
    onEvent: (event, turns) => watchEvent(watch, event, turns),
  });
  try {
    // a provider limit continues the same session on the next fallback (src/routing.ts), never waiting it out
    const result = await runRouted(session, job.prompt, job.models, job.ctx.provider.provider);
    run.text = result.text;
    run.error = result.error;
    run.budget = result.budget;
    run.providerDown = result.provider;
    // only a turn cap recovers: the worker read the code, so one no-tool prompt gets what it found (minute/cost caps are about spend)
    if (run.stopped?.cap === "turns") run.partialText = await partialAnswer(session);
  } finally {
    clearTimeout(caps.timer);
    const totals = session.totals();
    run.spent.turns = totals.turns;
    run.spent.calls = totals.calls;
    run.spent.costUsd = totals.usage.costUsd;
    try {
      recordSpend(totals.spend); // research draws on the same Go windows as jobs
    } catch {
      // the ledger only steers later escalations: never fail an answer over it
    }
  }
}

/** The answer of a run that gave none. */
function noAnswer(status: Answer["status"]): Answer {
  return { status, answer: "", refs: [] };
}

/**
 * The run's answer: what a turn-capped worker recovered, else the status its cap, provider, budget or error gives,
 * else its parsed reply.
 */
function workerAnswer(run: WorkerRun, parse: (text: string) => Answer | undefined): Answer {
  const turnCapped = run.stopped?.cap === "turns";
  const recovered = turnCapped && run.partialText ? parse(run.partialText) : undefined;
  if (recovered) return { ...recovered, partial: true };
  if (run.stopped) return noAnswer(run.stopped.status);
  if (run.providerDown) return noAnswer("FAIL");
  if (run.budget) return noAnswer("BUDGET");
  if (run.error) return noAnswer("FAIL");
  return parse(run.text) ?? noAnswer("FAIL");
}

/** The record's reason: the cap that stopped the run, a provider down, its budget, or the error or missing answer. */
function failureReason(run: WorkerRun, status: Answer["status"]): string | undefined {
  const providerReason = run.providerDown ? `provider down: ${run.providerDown}` : undefined;
  return run.stopped?.reason ?? providerReason ?? run.budget ?? errorReason(run.error, status);
}

/** A worker error, else "no answer" for a FAIL with nothing else to blame. */
function errorReason(error: string | undefined, status: Answer["status"]) {
  if (error) return `worker error: ${error}`;
  if (status === "FAIL") return "the research worker gave no answer";
  return undefined;
}

/** The worker's read-only ruleset, allowing the project's own scripts and its test command. */
function researchPermission(directory: string, config: Config) {
  const { scripts, exact } = projectScripts(directory);
  return researchRuleset({
    scripts,
    exact: [...exact, ...(config.test_cmd ? checkAllows(config.test_cmd) : [])],
    allowCommands: config.allow_commands,
  });
}

/** Starts the minute cap. `stop` records the first cap reached; every cap but the turn cap also aborts the session. */
function startCaps(run: WorkerRun, limits: Config["limits"]) {
  const halt = new AbortController();
  const stop = (why: Stop) => {
    run.stopped ??= why;
    if (why.cap !== "turns") halt.abort(); // a turn cap lets the turn end: partialAnswer() needs a live session (as src/jobs.ts)
  };
  const timer = setTimeout(
    () => stop({ status: "FAIL", reason: `minute cap (${limits.max_minutes} min) reached` }),
    limits.max_minutes * 60_000,
  );
  return { signal: halt.signal, stop, timer };
}

/** What a session event can reach: the job, the run it records into, the caps and the session's totals. */
type EventWatch = {
  job: WorkerJob;
  run: WorkerRun;
  stop: (why: Stop) => void;
  totals: () => ReturnType<Session["totals"]>;
};

/** Handles one session event: it is logged, a finished tool call is progress, and the turn and cost caps are checked. */
function watchEvent(watch: EventWatch, event: Event, turns: number) {
  const { job, run, stop } = watch;
  const { limits } = job.config;
  appendFileSync(join(job.directory, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
  if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
    const part = event.properties.part;
    recordToolCall(run, part);
    if (part.state.status === "completed" || part.state.status === "error") {
      job.ctx.progress(turns, `turn ${turns}: ${part.tool}`);
      if (turns >= limits.max_turns)
        stop({ status: "FAIL", reason: `turn cap (${limits.max_turns}) reached`, cap: "turns" });
    }
  }
  if (event.type === "message.updated" && watch.totals().usage.costUsd >= limits.max_cost_usd) {
    stop({ status: "BUDGET", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
  }
}

/** Records a completed read or bash call: the files read count in the record, the commands run back a repro. */
function recordToolCall(run: WorkerRun, part: ToolPart) {
  const { tool, state } = part;
  if (state.status !== "completed") return;
  if (tool === "read") run.files.add(String(state.input.filePath));
  if (tool === "bash")
    // oxlint-disable-next-line typescript/no-base-to-string -- safer cast changes the text
    run.ran.push(String(state.input.command ?? ""));
}

/**
 * The comma-separated `paths` as repo-relative scope entries. A path that does not exist is looked up by basename, and
 * `resolvedPaths` notes each one found that way. A path outside the repo, or one not found, gives a FAIL block instead.
 */
function resolveScope(
  root: string,
  paths: string,
): { scope: string[]; resolvedPaths: string[] } | { block: string } {
  const scope: string[] = [];
  const resolvedPaths: string[] = [];
  const entries = paths
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const path of entries) {
    const relativePath = normalisePath(relative(root, join(root, path)));
    if (isAbsolute(path) || relativePath === ".." || relativePath.startsWith("../")) {
      const message = `path ${path} must be inside the repository, relative to its root`;
      return { block: failBlock(message) };
    }
    if (existsSync(join(root, path))) {
      if (relativePath) scope.push(relativePath); // "." is the whole repo: no scope
      continue;
    }
    const found = findByBasename(root, path);
    if ("block" in found) return found;
    scope.push(found.path);
    resolvedPaths.push(`${path} resolved to ${found.path}`);
  }
  return { scope, resolvedPaths };
}

/** A path that does not exist, found by its basename among the tracked files: a miss may just be the wrong directory. */
function findByBasename(root: string, path: string): { path: string } | { block: string } {
  const name = basename(path);
  const matches = git(root, ["ls-files", "-z", "--", `*/${name}`, name])
    .split("\0")
    .filter(Boolean);
  if (!matches.length) return { block: failBlock(`path ${path} not found`) };
  if (matches.length > 1)
    return { block: failBlock(`path ${path} not found; did you mean: ${matches.join(", ")}`) };
  return { path: normalisePath(matches[0]) };
}

/** The worker's prompt: the question, its scope, the repro rule, the word cap, then the brief format. */
function researchPrompt(question: string, scope: string[], maxWords: number) {
  return [
    `Question: ${question}`,
    scope.length && `Scope: look only under ${scope.join(", ")}; cite only files there.`,
    REPRO_RULE,
    `Answer in at most ${maxWords} words.`,
    // repeated here because real models skipped the agent prompt's format (seen live): without it a right answer is UNSURE
    BRIEF_FORMAT,
  ]
    .filter(Boolean)
    .join("\n");
}

const PARTIAL_PROMPT =
  "You were stopped before finishing. Without calling any tool, answer the question now from what you read, in the cheapag-research block format with status: partial.";

/** One last no-tool prompt on a turn-capped session; any error, timeout or interruption gives no text. */
async function partialAnswer(session: Session): Promise<string> {
  try {
    const r = await session.run(PARTIAL_PROMPT, undefined, AbortSignal.timeout(30_000), true);
    return r.error || r.interrupted ? "" : r.text;
  } catch {
    return "";
  }
}

/** Research verifies before it claims (ticket 23.4: unverified handoffs inject false confidence). */
export const REPRO_RULE =
  "If the question is about a failure or wrong behaviour, reproduce it: run the relevant test or command and report exactly what it showed. Never claim a reproduction you did not run.";
export const BRIEF_FORMAT =
  "End your reply with exactly one fenced ```cheapag-research block: status (answer or unsure), confidence (high, medium or low), files (path:start-end, most relevant first, comma-separated), repro (`command` → what it showed, or not attempted), dead ends (what you ruled out, or none), then notes: and your prose.";

/**
 * A claimed reproduction stands only if its `command` is one the worker ran; otherwise it is marked unverified and the
 * confidence drops to low, so Claude doesn't build on a guess.
 */
export function verifyRepro(answer: Answer | undefined, ran: string[]): Answer | undefined {
  const repro = answer?.repro?.trim();
  if (!answer || !repro || /^not attempted|^none$/i.test(repro))
    return answer && { ...answer, repro: repro || undefined };
  const norm = (c: string) => c.replace(/\s+/g, " ").trim();
  const claimed = norm(repro.match(/`([^`]+)`/)?.[1] ?? "");
  const verified =
    !!claimed && ran.some((c) => norm(c).includes(claimed) || claimed.includes(norm(c)));
  return verified
    ? { ...answer, repro }
    : { ...answer, repro: `unverified (not run): ${repro}`, confidence: "low" };
}

/**
 * Jobs whose changes research cannot see (D7 note): not landed, and either still in flight (RUNNING or BLOCKED: their
 * changes may land later) or holding changes in a worktree that still exists (PARTIAL, FAIL, CONFLICT, TIMEOUT,
 * BUDGET, CANCELLED with edits; `land apply` could still land them). A discarded or cleaned-up job, or one that changed
 * nothing, has nothing to miss. Oldest first.
 */
export function unlandedJobs(root: string): string[] {
  return records(root)
    .filter(
      (r) =>
        !r.landed &&
        (r.status === "RUNNING" ||
          r.status === "BLOCKED" ||
          (!!r.worktree && !!r.changed?.length && existsSync(join(root, r.worktree)))),
    )
    .sort((a, b) =>
      String(a.timing?.startedAt ?? "").localeCompare(String(b.timing?.startedAt ?? "")),
    )
    .map((r) => r.job);
}

/**
 * The worker's last fenced `cheapag-research` block, parsed leniently. Without one, its final text is the answer,
 * UNSURE with low confidence (the worker never rated it). Nothing at all → undefined.
 */
export function parseAnswer(
  text: string,
  root: string,
  scope: string[],
  maxWords: number,
): Answer | undefined {
  const block = [...text.matchAll(/```cheapag-research[^\n]*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block)
    return text.trim()
      ? {
          status: "UNSURE",
          answer: capWords(text.trim(), maxWords),
          refs: refs(text, root, scope),
          confidence: "low",
        }
      : undefined;
  const fields = briefFields(block);
  const answer = (fields.answer ?? "").trim();
  if (!answer) return undefined;
  const listed = refs(fields.refs ?? "", root, scope);
  const status = fields.status?.trim() ?? "";
  return {
    status: /^unsure/i.test(status) ? "UNSURE" : "ANSWER",
    partial: /^partial/i.test(status) || undefined,
    answer: capWords(answer, maxWords),
    // refs from the refs line; failing that, any cited in the prose
    refs: listed.length ? listed : refs(answer, root, scope),
    confidence: confidenceLevel(fields.confidence),
    repro: fields.repro?.trim() || undefined,
    deadEnds: ruledOut(fields.deadEnds),
  };
}

/** A brief line: one of the field names, a colon, then its value. */
const FIELD_LINE = /^\s*(status|confidence|refs|files|repro|dead[ _]ends|answer|notes):\s*(.*)$/i;
/** The brief's names that the record names differently; the older refs and answer are still read as they are. */
const RECORD_NAMES: Record<string, string> = {
  files: "refs",
  notes: "answer",
  "dead ends": "deadEnds",
  dead_ends: "deadEnds",
};

/** The brief's fields under their record names. Lines that are not a field belong to the answer when it came last. */
function briefFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block.split("\n")) {
    const field = line.match(FIELD_LINE);
    if (field) {
      const name = field[1].toLowerCase();
      key = RECORD_NAMES[name] ?? name;
      fields[key] = field[2];
    } else if (key === "answer") fields.answer += `\n${line}`; // the answer is prose: it may span lines
  }
  return fields;
}

/** The rated confidence, read from the start of the field; low when it is missing or not a level. */
function confidenceLevel(rated: string | undefined): NonNullable<Answer["confidence"]> {
  const level = rated
    ?.trim()
    .toLowerCase()
    .match(/^(high|medium|low)/)?.[1];
  return (level as Answer["confidence"]) ?? "low";
}

/** What the worker ruled out, unless it wrote none. */
function ruledOut(deadEnds: string | undefined) {
  const trimmed = deadEnds?.trim();
  return trimmed && !/^none\.?$/i.test(trimmed) ? trimmed : undefined;
}

/** The raw `path:line(-line)` candidates in text, before validation. Accepts a Windows drive letter and backslashes. */
export function refTokens(text: string): { path: string; from: string; to: string | undefined }[] {
  return [...text.matchAll(/((?:[A-Za-z]:)?[\w./\\@-]+):(\d+)(?:-(\d+))?/g)].map(
    ([, path, from, to]) => ({ path, from, to }),
  );
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
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith("../") ||
      isAbsolute(rel) ||
      start < 1 ||
      end < start
    )
      continue;
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
    const id = newId("r");
    const directory = join(root, ".cheapag", "jobs", id);
    if (existsSync(directory)) continue;
    mkdirSync(directory, { recursive: true });
    return { id, directory };
  }
}

/** Writes one file of the research log with keys redacted; a value that is not a string is written as JSON. */
function writeLog(directory: string, name: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(directory, name), redact(text));
}
