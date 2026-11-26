import type { Changed } from "./workspace.js";

/**
 * Report: renders `cheapag/1` result blocks (spec Result format contract, D3–D9) from records. Pure: no I/O.
 *
 * Record-field contract. An empty or absent field omits its section; sections keep the order listed here.
 * - Every job block: headline from status, job, steps, changed (files= +a/-d), tests (absent → no `tests=`, for a job
 *   that never reached verify, e.g. BLOCKED), usage.turns (model rounds), usage.costUsd, then the optional tokens selfFix → fix=N,
 *   models.escalated → esc=1, models.final ≠ models.requested → model=<final>, redo → redo=1, billing → billing=zen.
 *   Then summary, changed, risks, review, the status's own sections, and `log:` last.
 * - Status sections (STATUS_SECTIONS): OK none · PARTIAL found, missing, worktree · FAIL error, found, tried, reason, worktree ·
 *   BLOCKED question {text, options ≤ 4} · CONFLICT conflict[], worktree · CANCELLED reason, worktree ·
 *   TIMEOUT found, reason, missing, worktree · BUDGET found, reason, worktree · PROVIDER found, reason, worktree. `found` (a stopped worker's note, ≤ 600 chars) wraps, never cut.
 * - RUNNING is one line: `RUNNING <job> step=<steps> turns=<usage.turns>`.
 * - CONSENT has no job: `renderConsent` (used for research too). Research: `renderResearch` (D7). Batch: `renderBatch` (D6).
 * Paths in records are already repo-relative with forward slashes (builders use `normalisePath`).
 */

export type JobStatus =
  | "OK"
  | "PARTIAL"
  | "FAIL"
  | "BLOCKED"
  | "CONFLICT"
  | "RUNNING"
  | "CANCELLED"
  | "TIMEOUT"
  | "BUDGET"
  | "PROVIDER";
type Range = { path: string; start: number; end: number };

/** The fields the renderer reads from a job record (the on-disk record, D10, is a superset). */
export type JobRecord = {
  format: "cheapag/1";
  job: string;
  status: JobStatus;
  landed: boolean;
  steps: string;
  summary: string;
  changed: Changed[];
  risks: string[];
  review: Range[];
  missing: string[];
  reason?: string;
  worktree: string | null;
  /** Removing a landed job's worktree failed; the job's status is unaffected (its change already landed). */
  cleanupError?: string;
  usage: { turns: number; calls?: number; costUsd: number };
  /** Absent when verification never ran: the headline then has no `tests=`. */
  tests?: "pass" | "fail" | "none";
  selfFix: number;
  models: { requested: string; final: string; escalated: boolean };
  /** The de-noised tail of the last failing verify command: the command first, then indented lines. */
  error?: string[];
  /** `env`: the failing check could not run (missing tool, broken Node), so the code may still be fine. */
  check?: "env";
  tried?: string[];
  /** A stopped worker's findings note (ticket 29): where the bug is, its hypothesis, what it ruled out. */
  found?: string;
  /** `answer` is the reply sent (null while waiting); recorded, not rendered. */
  question?: { text: string; options: string[]; answer?: string | null } | null;
  /** Several questions asked at once (then `question` is null), answered one by one. */
  questions?: NonNullable<JobRecord["question"]>[];
  /** A bash command the worker asked permission for, paused as BLOCKED (ticket 69); `answer` is the reply sent, recorded not rendered. */
  permission?: PermissionBlock | null;
  /** One line per conflicting path, e.g. `src/a.ts (also changed by j3d54, landed first; redo could not reconcile)`. */
  conflict?: string[];
  redo?: number | null;
  billing?: "zen";
  /** The worker's reproduction test, checked by the server: failed on the original code and passes now, or not. */
  repro?: "fail→pass" | "unverified" | "none";
  /** The first changed test file: what Claude reads instead of the diff after a medium/hard OK (ticket 28). */
  test?: string;
};

/** A command the worker asked permission for, shown as a BLOCKED block with lettered options. */
export type PermissionBlock = {
  title: string;
  command: string;
  why: string;
  prefix: string;
  always?: boolean;
  answer?: string | null;
};

export type ResearchRecord = {
  format: "cheapag/1";
  job: string;
  status: "ANSWER" | "UNSURE" | "FAIL" | "BUDGET";
  /** An ANSWER recovered after a turn cap, or one the worker marked `status: partial`: what was found so far. */
  partial?: boolean;
  filesRead: number;
  usage: { turns: number; calls?: number; costUsd: number };
  models?: { requested: string; final: string };
  /** Prose, may span lines (the brief's `notes:`). */
  answer: string;
  /** The brief's `files:`, ranked most relevant first. */
  refs: Range[];
  /** The reproduction: the command run and what it showed, `unverified: …` when no such command ran, or "not attempted". */
  repro?: string;
  deadEnds?: string;
  confidence?: "high" | "medium" | "low";
  reason?: string;
  /** Cleanup failure is separate from the worker's status and reason. */
  cleanupError?: string;
  /** Repo-relative worktree retained when cleanup fails. */
  worktree?: string;
  /** Jobs not yet landed, whose changes research could not see. */
  unlanded: string[];
};

export type BatchRecord = {
  format: "cheapag/1";
  batch: string;
  /** Each group's steps, e.g. `1-2`. */
  groups: string[];
  notes: string[];
  /** none: there is no integration_cmd or test_cmd to run. */
  integration: "pass" | "fail" | "pending" | "running" | "none";
  /** The de-noised tail of a failing integration check, command first. */
  integrationError?: string[];
  jobs: string[];
  /** The integration fix job, once a failing check started one. */
  fix?: string;
};

export type ConsentRecord = { repo: string; send: string; retention: string; approve: string };

type Section =
  "question" | "conflict" | "error" | "found" | "tried" | "reason" | "missing" | "worktree";
const STATUS_SECTIONS: Record<Exclude<JobStatus, "RUNNING">, Section[]> = {
  OK: [],
  PARTIAL: ["found", "missing", "worktree"],
  FAIL: ["error", "found", "tried", "reason", "worktree"],
  BLOCKED: ["question"],
  CONFLICT: ["conflict", "worktree"],
  CANCELLED: ["reason", "worktree"],
  TIMEOUT: ["found", "reason", "missing", "worktree"],
  BUDGET: ["found", "reason", "worktree"],
  PROVIDER: ["found", "reason", "worktree"],
};
// a batch block shows only the status sections of these settled jobs (OK keeps risks:); every other status renders in full
const COMPACTED = new Set<JobStatus>(["OK", "PARTIAL", "FAIL"]);
// D6 urgency; CANCELLED is not ranked by the spec and sits with BUDGET/TIMEOUT
const URGENCY: JobStatus[] = [
  "BLOCKED",
  "CONFLICT",
  "FAIL",
  "BUDGET",
  "PROVIDER",
  "TIMEOUT",
  "CANCELLED",
  "PARTIAL",
  "RUNNING",
  "OK",
];
function urgencyRank(status: JobStatus) {
  if (status === "PROVIDER" || status === "TIMEOUT" || status === "CANCELLED")
    return URGENCY.indexOf("BUDGET");
  return URGENCY.indexOf(status);
}

/** The summary a worker that never reported gets (src/worker.ts). */
export const NO_SUMMARY = "(worker gave no summary)";
const BUDGET_TOKENS = 400;
const CHARS_PER_TOKEN = 4;
const ERROR_LINES_FLOOR = 12;
const LINE_MAX = 200;

/** How much of each cuttable section a layout keeps (D9 truncation). */
type Cuts = {
  changed: number;
  tried: number;
  risks: number;
  review: number;
  error: number;
  summary: number;
};
const FULL: Cuts = {
  changed: 15,
  tried: Infinity,
  risks: 5,
  review: 5,
  error: Infinity,
  summary: 160,
};

/** A FAIL before any job exists (bad input, setup). */
export const failBlock = (reason: string) => `FAIL reason: ${reason}`;

/** The three lettered options a permission block offers; letter "b" names the prefix the server would save. */
export const permissionOptions = (prefix: string) => [
  "allow once",
  `always allow \`${prefix}\` in this repo (adds it to cheapag.json allow_commands)`,
  "refuse",
];

/** D5-adjacent: a BLOCKED job paused on a command permission, rendered outside the ordinary job layout. */
function renderPermission(record: JobRecord) {
  const permission = record.permission!;
  const [once, always, refuse] = permissionOptions(permission.prefix);
  return [
    `BLOCKED ${record.job} step=${record.steps} permission`,
    `title: ${oneLine(permission.title)}`,
    `command: ${oneLine(permission.command)}`,
    `why: ${oneLine(permission.why)}`,
    `a) ${once}`,
    ...(permission.always === false ? [] : [`b) ${always}`]),
    `c) ${refuse}`,
    "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.",
  ]
    .map(fit)
    .join("\n");
}

/** A job block within `budget` tokens (chars/4), cutting in D9 order only while over it. Never cut: headline, question/options, conflict, reason, worktree, log. */
export function renderJob(r: JobRecord, budget = BUDGET_TOKENS, compact = false) {
  if (r.status === "RUNNING") return fit(`RUNNING ${r.job} step=${r.steps} turns=${r.usage.turns}`);
  if (r.status === "BLOCKED" && r.permission) return renderPermission(r);
  let cuts = FULL;
  let text = layout(r, cuts, compact);
  const overBudget = () => text.length / CHARS_PER_TOKEN > budget;
  const cut = (smaller: Partial<Cuts>) => {
    if (!overBudget()) return;
    cuts = { ...cuts, ...smaller };
    text = layout(r, cuts, compact);
  };
  cut({ changed: 5 });
  cut({ tried: 1 });
  cut({ risks: 3 });
  cut({ review: 3 });
  let errorLimit = r.error?.length ?? 0;
  while (errorLimit > ERROR_LINES_FLOOR && overBudget()) {
    errorLimit -= 1;
    cut({ error: errorLimit });
  }
  cut({ summary: 100 });
  return text;
}

/** One job block at the given cuts: headline, what the worker did, the status's own sections, `log:` last. */
function layout(record: JobRecord, cuts: Cuts, compact = false) {
  const sections = sectionsOf(record);
  const compacted = compact && COMPACTED.has(record.status);
  // a worker with no summary has nothing to put there: `found:` leads instead
  const foundLeads =
    !compacted &&
    record.summary === NO_SUMMARY &&
    sections.includes("found") &&
    Boolean(record.found);
  const questions = sections.includes("question") ? questionLines(record) : [];
  const lines = [
    jobHeadline(record),
    ...workLines(record, cuts, { compacted, foundLeads }),
    ...questions,
    ...problemLines(record, cuts, foundLeads),
    ...followUpLines(record),
  ];
  if (record.cleanupError)
    lines.push(
      `cleanup error: ${oneLine(record.cleanupError)} (the change landed; only its worktree folder was left behind)`,
    );
  if (!compacted) lines.push(`log: .cheapag/jobs/${record.job}/`);
  const neverElided = new Set(questions); // question/options lines are never elided
  return lines
    .map((line) => (neverElided.has(line) ? line.replaceAll("\t", "  ") : fit(line)))
    .join("\n");
}

/** The first line: status, job, steps, file counts, then the optional tokens in D3 order. */
function jobHeadline(record: JobRecord) {
  const added = record.changed.reduce((total, file) => total + file.add, 0);
  const deleted = record.changed.reduce((total, file) => total + file.del, 0);
  const modelChanged = record.models.final !== record.models.requested;
  return [
    record.status,
    record.job,
    `step=${record.steps}`,
    `files=${record.changed.length}`,
    `+${added}/-${deleted}`,
    record.tests && `tests=${record.tests}`,
    record.check && `check=${record.check}`,
    `turns=${record.usage.turns}`,
    `cost=$${record.usage.costUsd.toFixed(3)}`,
    record.selfFix && `fix=${record.selfFix}`,
    record.models.escalated && "esc=1",
    modelChanged && `model=${record.models.final}`,
    record.redo && "redo=1",
    record.billing && `billing=${record.billing}`,
    record.repro && `repro=${record.repro}`,
    record.test && `test=${record.test}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** How a job block is shown: compacted in a batch, and whether `found:` took the summary's place. */
type BlockView = { compacted: boolean; foundLeads: boolean };

/** What the worker did: its summary (or `found:` in its place), changed files, risks, review ranges. */
function workLines(record: JobRecord, cuts: Cuts, view: BlockView) {
  // a compacted batch block drops summary/changed/review/log (OK's risks: survive)
  if (view.compacted) return record.status === "OK" ? riskLines(record.risks, cuts.risks) : [];
  const lines: string[] = [];
  if (view.foundLeads) lines.push(...foundLines(record.found!));
  else if (record.summary) lines.push(`summary: ${clip(oneLine(record.summary), cuts.summary)}`);
  // D5: a BLOCKED block counts its files in the headline but lists them only once the job settles
  if (record.changed.length && record.status !== "BLOCKED")
    lines.push(...changedLines(record.changed, cuts.changed));
  lines.push(...riskLines(record.risks, cuts.risks));
  if (record.review.length) {
    const shown = record.review.slice(0, cuts.review);
    const ranges = shown.map((range) => `${range.path}:${range.start}-${range.end}`);
    lines.push(`review: ${ranges.join(", ")}`);
  }
  return lines;
}

/** A stopped worker's note: wrapped at spaces, never cut. */
function foundLines(found: string) {
  return wrap(`found: ${oneLine(found)}`);
}

const RISK_MAX = 120;

/** The `risks:` list, cut to `limit` risks, each clipped to RISK_MAX chars. */
function riskLines(risks: string[], limit: number) {
  if (!risks.length) return [];
  const shown = risks.slice(0, limit);
  return ["risks:", ...shown.map((risk) => `  - ${clip(oneLine(risk), RISK_MAX)}`)];
}

/** The `changed:` list, cut to `limit` files with a count of the rest. */
function changedLines(changed: Changed[], limit: number) {
  const lines = ["changed:", ...changed.slice(0, limit).map(changedLine)];
  if (changed.length > limit) lines.push(`  … +${changed.length - limit} more`);
  return lines;
}

/** One changed file: its git status and path, then the added and deleted counts that are not zero. */
function changedLine(file: Changed) {
  const added = file.add ? ` +${file.add}` : "";
  const deleted = file.del ? ` -${file.del}` : "";
  return `  ${file.status} ${file.path}${added}${deleted}`;
}

/** Every question asked, numbered when there are several, each with its lettered options. */
function questionLines(record: JobRecord) {
  const asked = record.questions ?? (record.question ? [record.question] : []);
  return asked.flatMap((question, index) => {
    const number = asked.length > 1 ? ` ${index + 1}` : "";
    const lines = [`question${number}: ${oneLine(question.text)}`];
    if (question.options.length) lines.push("options:", ...optionLines(question.options));
    return lines;
  });
}

/** Up to four options, lettered a) to d). */
function optionLines(options: string[]) {
  const letters = "abcd";
  return options
    .slice(0, letters.length)
    .map((option, index) => `  ${letters[index]}) ${oneLine(option)}`);
}

/** The sections a status shows; RUNNING never reaches the layout. */
function sectionsOf(record: JobRecord) {
  return STATUS_SECTIONS[record.status as Exclude<JobStatus, "RUNNING">];
}

/** What went wrong: the conflict, the error tail, the worker's `found:` note, the fixes tried, the reason. */
function problemLines(record: JobRecord, cuts: Cuts, foundLeads: boolean) {
  const has = (section: Section) => sectionsOf(record).includes(section);
  const lines: string[] = [];
  if (has("conflict") && record.conflict?.length)
    lines.push("conflict:", ...record.conflict.map((entry) => `  ${oneLine(entry)}`));
  if (has("error") && record.error?.length)
    lines.push(...errorLines(record.error, cuts.error, record.check));
  if (has("found") && record.found && !foundLeads) lines.push(...foundLines(record.found));
  if (has("tried") && record.tried?.length) {
    const tried = record.tried.slice(-cuts.tried);
    lines.push("tried:", ...tried.map((attempt) => `  - ${oneLine(attempt)}`));
  }
  if (has("reason") && record.reason) lines.push(`reason: ${oneLine(record.reason)}`);
  return lines;
}

/** The `error:` tail, cut to `limit` lines with its last line counting the rest. */
function errorLines(error: string[], limit: number, check: JobRecord["check"]) {
  const kept = error.slice(0, limit);
  if (kept.length < error.length)
    kept[kept.length - 1] = `  … +${error.length - kept.length + 1} more lines (see log)`;
  const [first, ...rest] = kept;
  // an env failure carries the reason first, then the ordinary tail (the command and its output)
  if (check === "env") return [`error: environment: the check could not run (${first})`, ...rest];
  return [`error: ${first}`, ...rest];
}

const PROVIDER_NEXT =
  "next: ask the user: continue with Claude, or switch the worker to another model (delegate again with model: <id>)";

/** What comes next: PROVIDER's question for the user, the missing work, the worktree that holds it. */
function followUpLines(record: JobRecord) {
  const has = (section: Section) => sectionsOf(record).includes(section);
  const lines: string[] = [];
  if (record.status === "PROVIDER") lines.push(PROVIDER_NEXT);
  if (has("missing") && record.missing.length)
    lines.push("missing:", ...record.missing.map((item) => `  - ${oneLine(item)}`));
  if (has("worktree") && record.worktree) lines.push(`worktree: ${record.worktree}/`);
  return lines;
}

/** D7. A research CONSENT renders through `renderConsent`. */
export function renderResearch(r: ResearchRecord) {
  const lines = [researchHeadline(r)];
  // a scout brief: ranked files, the reproduction, dead ends, then the prose
  if (r.refs.length) lines.push(`files: ${r.refs.map(refText).join(", ")}`);
  if (r.repro) lines.push(`repro: ${oneLine(r.repro)}`);
  if (r.deadEnds) lines.push(`dead ends: ${oneLine(r.deadEnds)}`);
  const notes = r.answer.trim();
  // prose is word-wrapped, not elided like other long lines
  if (notes) lines.push("notes:", ...notes.split("\n").flatMap((line) => wrap(line.trimEnd())));
  if (r.confidence) lines.push(`confidence: ${r.confidence}`);
  if (r.reason) lines.push(`reason: ${oneLine(r.reason)}`);
  if (r.cleanupError) lines.push(`cleanup error: ${oneLine(r.cleanupError)}`);
  if (r.worktree) lines.push(`worktree: ${r.worktree}/`);
  const count = r.unlanded.length;
  if (count)
    lines.push(
      `note: ${count} job${count > 1 ? "s" : ""} not yet landed (${r.unlanded.join(", ")}); their changes are not visible to research`,
    );
  lines.push(`log: .cheapag/jobs/${r.job}/`);
  return lines.map(fit).join("\n");
}

/** The first line: status, job, files read, turns, cost, then a fallback model and a partial answer. */
function researchHeadline(record: ResearchRecord) {
  const { models } = record;
  return [
    record.status,
    record.job,
    `files_read=${record.filesRead}`,
    `turns=${record.usage.turns}`,
    `cost=$${record.usage.costUsd.toFixed(3)}`,
    models && models.final !== models.requested && `model=${models.final}`,
    record.partial && "status=partial",
  ]
    .filter(Boolean)
    .join(" ");
}

/** `path:start`, or `path:start-end` when the range spans lines. */
function refText(ref: Range) {
  const end = ref.end !== ref.start ? `-${ref.end}` : "";
  return `${ref.path}:${ref.start}${end}`;
}

/**
 * D6: header, notes, integration error, the integration fix job's block, then job blocks by urgency (RUNNING ones as
 * adjacent single lines), then `next:`. The fix job is not a group: it counts in the cost only.
 */
export function renderBatch(b: BatchRecord, jobs: JobRecord[], fix?: JobRecord) {
  const sorted = [...jobs].sort(
    (left, right) => urgencyRank(left.status) - urgencyRank(right.status),
  );
  const head = [batchHeadline(b, jobs, fix)];
  if (b.notes.length) head.push(`note: ${b.notes.join("; ")}`);
  if (b.integrationError?.length)
    head.push(`error: ${b.integrationError[0]}`, ...b.integrationError.slice(1));
  const chunks = fix ? [renderJob(fix)] : [];
  sorted.forEach((job, index) => {
    if (job.status === "RUNNING" && sorted[index - 1]?.status === "RUNNING")
      chunks[chunks.length - 1] += `\n${renderJob(job)}`;
    else chunks.push(renderJob(job, BUDGET_TOKENS, true));
  });
  const next = nextStep(b, sorted);
  // only blocks that were compacted have more to show
  const settled = sorted.filter((job) => COMPACTED.has(job.status)).map((job) => job.job);
  const full = settled.length ? fit(`full blocks: jobs show ${settled.join(", ")}`) : "";
  return [head.map(fit).join("\n"), chunks.join("\n\n"), full, next && fit(`next: ${next}`)]
    .filter(Boolean)
    .join("\n");
}

/** The BATCH line: groups, a count per status by urgency, landed, integration, cost (fix included). */
function batchHeadline(batch: BatchRecord, jobs: JobRecord[], fix?: JobRecord) {
  const counts = URGENCY.map(
    (status) => [status, jobs.filter((job) => job.status === status).length] as const,
  ).filter(([, count]) => count);
  const billed = [...jobs, ...(fix ? [fix] : [])];
  const cost = billed.reduce((total, job) => total + job.usage.costUsd, 0);
  return [
    `BATCH ${batch.batch} groups=${batch.groups.length}`,
    ...counts.map(([status, count]) => `${status}=${count}`),
    `landed=${jobs.filter((job) => job.landed).length}`,
    `integration=${batch.integration}`,
    `cost=$${cost.toFixed(3)}`,
  ].join(" ");
}

/** Reply to the first BLOCKED job, then wait while anything is open; empty when nothing is. */
function nextStep(batch: BatchRecord, sorted: JobRecord[]) {
  const blocked = sorted.find((job) => job.status === "BLOCKED");
  const open = sorted.some((job) => job.status === "BLOCKED" || job.status === "RUNNING");
  return [
    blocked && `reply(job="${blocked.job}", ...)`,
    (batch.integration === "running" || open) && `jobs(action="wait", job="${batch.batch}")`,
  ]
    .filter(Boolean)
    .join(" then ");
}

/** D5 CONSENT: no job is created. */
export const renderConsent = (c: ConsentRecord) =>
  [
    `CONSENT repo=${c.repo}`,
    `send: ${c.send}`,
    `retention: ${c.retention}`,
    `approve: ${c.approve}`,
  ]
    .map(fit)
    .join("\n");

/** Trimmed, with each newline and the whitespace around it made one space. */
function oneLine(text: string) {
  return text.trim().replace(/\s*\n\s*/g, " ");
}

/** Cut to `max` chars, the last of them an ellipsis. */
function clip(text: string, max: number) {
  if (text.length > max) return `${text.slice(0, max - 1)}…`;
  return text;
}

/** A line broken at spaces into lines of at most 200 chars (a longer word is left to `fit`). */
function wrap(line: string) {
  const lines = [""];
  for (const word of line.replaceAll("\t", "  ").split(" ")) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length > LINE_MAX) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines;
}

/** D9 line rules: no tabs (2 spaces), at most 200 chars with the middle elided. */
function fit(line: string) {
  const untabbed = line.replaceAll("\t", "  ");
  if (untabbed.length <= LINE_MAX) return untabbed;
  const half = (LINE_MAX - 1) / 2;
  const head = untabbed.slice(0, Math.ceil(half));
  const tail = untabbed.slice(untabbed.length - Math.floor(half));
  return `${head}…${tail}`;
}
