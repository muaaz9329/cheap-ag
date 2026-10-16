import type { Changed } from "./workspace.js";

/**
 * Report: renders `cheapag/1` result blocks (spec Result format contract, D3–D9) from records. Pure: no I/O.
 *
 * Record-field contract. An empty or absent field omits its section; sections keep the order listed here.
 * - Every job block: headline from status, job, steps, changed (files= +a/-d), tests (absent → no `tests=`, for a job
 *   that never reached verify, e.g. BLOCKED), usage.turns, usage.costUsd, then the optional tokens selfFix → fix=N,
 *   models.escalated → esc=1, models.final ≠ models.requested → model=<final>, redo → redo=1, billing → billing=zen.
 *   Then summary, changed, risks, review, the status's own sections, and `log:` last.
 * - Status sections (STATUS_SECTIONS): OK none · PARTIAL missing, worktree · FAIL error, tried, reason, worktree ·
 *   BLOCKED question {text, options ≤ 4} · CONFLICT conflict[], worktree · CANCELLED reason, worktree ·
 *   TIMEOUT reason, missing, worktree · BUDGET reason, worktree.
 * - RUNNING is one line: `RUNNING <job> step=<steps> turns=<usage.turns>`.
 * - CONSENT has no job: `renderConsent` (used for research too). Research: `renderResearch` (D7). Batch: `renderBatch` (D6).
 * Paths in records are already repo-relative with forward slashes (builders use `normalisePath`).
 */

export type JobStatus = "OK" | "PARTIAL" | "FAIL" | "BLOCKED" | "CONFLICT" | "RUNNING" | "CANCELLED" | "TIMEOUT" | "BUDGET";
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
  usage: { turns: number; costUsd: number };
  /** Absent when verification never ran: the headline then has no `tests=`. */
  tests?: "pass" | "fail" | "none";
  selfFix: number;
  models: { requested: string; final: string; escalated: boolean };
  /** The de-noised tail of the last failing verify command: the command first, then indented lines. */
  error?: string[];
  tried?: string[];
  /** `answer` is the reply sent (null while waiting); recorded, not rendered. */
  question?: { text: string; options: string[]; answer?: string | null } | null;
  /** Several questions asked at once (then `question` is null), answered one by one. */
  questions?: NonNullable<JobRecord["question"]>[];
  /** One line per conflicting path, e.g. `src/a.ts (also changed by j3d54, landed first; redo could not reconcile)`. */
  conflict?: string[];
  redo?: number | null;
  billing?: "zen";
};

export type ResearchRecord = {
  format: "cheapag/1";
  job: string;
  status: "ANSWER" | "UNSURE" | "FAIL" | "BUDGET";
  filesRead: number;
  usage: { turns: number; costUsd: number };
  models?: { requested: string; final: string };
  /** Prose, may span lines. */
  answer: string;
  refs: Range[];
  confidence?: "high" | "medium" | "low";
  reason?: string;
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

type Section = "question" | "conflict" | "error" | "tried" | "reason" | "missing" | "worktree";
const STATUS_SECTIONS: Record<Exclude<JobStatus, "RUNNING">, Section[]> = {
  OK: [],
  PARTIAL: ["missing", "worktree"],
  FAIL: ["error", "tried", "reason", "worktree"],
  BLOCKED: ["question"],
  CONFLICT: ["conflict", "worktree"],
  CANCELLED: ["reason", "worktree"],
  TIMEOUT: ["reason", "missing", "worktree"],
  BUDGET: ["reason", "worktree"],
};
// D6 urgency; CANCELLED is not ranked by the spec and sits with BUDGET/TIMEOUT
const URGENCY: JobStatus[] = ["BLOCKED", "CONFLICT", "FAIL", "BUDGET", "TIMEOUT", "CANCELLED", "PARTIAL", "RUNNING", "OK"];
const rank = (s: JobStatus) => (s === "TIMEOUT" || s === "CANCELLED" ? URGENCY.indexOf("BUDGET") : URGENCY.indexOf(s));

const BUDGET_TOKENS = 400;
const LINE_MAX = 200;

/** How much of each cuttable section a layout keeps (D9 truncation). */
type Cuts = { changed: number; tried: number; risks: number; review: number; error: number; summary: number };
const FULL: Cuts = { changed: 15, tried: Infinity, risks: 5, review: 5, error: Infinity, summary: 160 };

/** A FAIL before any job exists (bad input, setup). */
export const failBlock = (reason: string) => `FAIL reason: ${reason}`;

/** A job block within `budget` tokens (chars/4), cutting in D9 order only while over it. Never cut: headline, question/options, conflict, reason, worktree, log. */
export function renderJob(r: JobRecord, budget = BUDGET_TOKENS) {
  if (r.status === "RUNNING") return fit(`RUNNING ${r.job} step=${r.steps} turns=${r.usage.turns}`);
  let cuts = FULL;
  let text = layout(r, cuts);
  const over = () => text.length / 4 > budget;
  const cut = (c: Partial<Cuts>) => {
    if (over()) text = layout(r, (cuts = { ...cuts, ...c }));
  };
  cut({ changed: 5 });
  cut({ tried: 1 });
  cut({ risks: 3 });
  cut({ review: 3 });
  for (let n = r.error?.length ?? 0; n > 12 && over(); ) cut({ error: --n });
  cut({ summary: 100 });
  return text;
}

function layout(r: JobRecord, c: Cuts) {
  const sections = STATUS_SECTIONS[r.status as Exclude<JobStatus, "RUNNING">];
  const has = (s: Section) => sections.includes(s);
  const add = r.changed.reduce((n, x) => n + x.add, 0);
  const del = r.changed.reduce((n, x) => n + x.del, 0);
  const lines = [
    [
      r.status, r.job, `step=${r.steps}`, `files=${r.changed.length}`, `+${add}/-${del}`, r.tests && `tests=${r.tests}`,
      `turns=${r.usage.turns}`, `cost=$${r.usage.costUsd.toFixed(3)}`,
      r.selfFix && `fix=${r.selfFix}`, r.models.escalated && "esc=1",
      r.models.final !== r.models.requested && `model=${r.models.final}`, r.redo && "redo=1", r.billing && `billing=${r.billing}`,
    ].filter(Boolean).join(" "),
  ];
  const keep = new Set<string>(); // question/options lines are never elided
  if (r.summary) lines.push(`summary: ${clip(oneLine(r.summary), c.summary)}`);
  // D5: a BLOCKED block counts its files in the headline but lists them only once the job settles
  if (r.changed.length && r.status !== "BLOCKED") {
    lines.push("changed:", ...r.changed.slice(0, c.changed).map((x) => `  ${x.status} ${x.path}${x.add ? ` +${x.add}` : ""}${x.del ? ` -${x.del}` : ""}`));
    if (r.changed.length > c.changed) lines.push(`  … +${r.changed.length - c.changed} more`);
  }
  if (r.risks.length) lines.push("risks:", ...r.risks.slice(0, c.risks).map((x) => `  - ${clip(oneLine(x), 120)}`));
  if (r.review.length) lines.push(`review: ${r.review.slice(0, c.review).map((v) => `${v.path}:${v.start}-${v.end}`).join(", ")}`);
  const asked = r.questions ?? (r.question ? [r.question] : []);
  if (has("question")) asked.forEach((question, n) => {
    const q = [`question${asked.length > 1 ? ` ${n + 1}` : ""}: ${oneLine(question.text)}`];
    if (question.options.length) q.push("options:", ...question.options.slice(0, 4).map((o, i) => `  ${"abcd"[i]}) ${oneLine(o)}`));
    q.forEach((l) => keep.add(l));
    lines.push(...q);
  });
  if (has("conflict") && r.conflict?.length) lines.push("conflict:", ...r.conflict.map((x) => `  ${oneLine(x)}`));
  if (has("error") && r.error?.length) {
    const e = r.error.slice(0, c.error);
    if (e.length < r.error.length) e[e.length - 1] = `  … +${r.error.length - e.length + 1} more lines (see log)`;
    lines.push(`error: ${e[0]}`, ...e.slice(1));
  }
  if (has("tried") && r.tried?.length) lines.push("tried:", ...r.tried.slice(-c.tried).map((x) => `  - ${oneLine(x)}`));
  if (has("reason") && r.reason) lines.push(`reason: ${oneLine(r.reason)}`);
  if (has("missing") && r.missing.length) lines.push("missing:", ...r.missing.map((x) => `  - ${oneLine(x)}`));
  if (has("worktree") && r.worktree) lines.push(`worktree: ${r.worktree}/`);
  lines.push(`log: .cheapag/jobs/${r.job}/`);
  return lines.map((l) => (keep.has(l) ? l.replaceAll("\t", "  ") : fit(l))).join("\n");
}

/** D7. A research CONSENT renders through `renderConsent`. */
export function renderResearch(r: ResearchRecord) {
  const lines = [
    [
      r.status, r.job, `files_read=${r.filesRead}`, `turns=${r.usage.turns}`, `cost=$${r.usage.costUsd.toFixed(3)}`,
      r.models && r.models.final !== r.models.requested && `model=${r.models.final}`,
    ].filter(Boolean).join(" "),
  ];
  // prose is word-wrapped, not elided like other long lines
  if (r.answer.trim()) lines.push(...r.answer.trim().split("\n").flatMap((l) => wrap(l.trimEnd())));
  if (r.refs.length) lines.push(`refs: ${r.refs.map((v) => `${v.path}:${v.start}${v.end !== v.start ? `-${v.end}` : ""}`).join(", ")}`);
  if (r.confidence) lines.push(`confidence: ${r.confidence}`);
  if (r.reason) lines.push(`reason: ${oneLine(r.reason)}`);
  const n = r.unlanded.length;
  if (n) lines.push(`note: ${n} job${n > 1 ? "s" : ""} not yet landed (${r.unlanded.join(", ")}); their changes are not visible to research`);
  lines.push(`log: .cheapag/jobs/${r.job}/`);
  return lines.map(fit).join("\n");
}

/**
 * D6: header, notes, integration error, the integration fix job's block, then job blocks by urgency (RUNNING ones as
 * adjacent single lines), then `next:`. The fix job is not a group: it counts in the cost only.
 */
export function renderBatch(b: BatchRecord, jobs: JobRecord[], fix?: JobRecord) {
  const sorted = [...jobs].sort((x, y) => rank(x.status) - rank(y.status));
  const counts = URGENCY.map((s) => [s, sorted.filter((j) => j.status === s).length] as const).filter(([, n]) => n);
  const head = [
    [
      `BATCH ${b.batch} groups=${b.groups.length}`, ...counts.map(([s, n]) => `${s}=${n}`),
      `landed=${jobs.filter((j) => j.landed).length}`, `integration=${b.integration}`,
      `cost=$${[...jobs, ...(fix ? [fix] : [])].reduce((n, j) => n + j.usage.costUsd, 0).toFixed(3)}`,
    ].join(" "),
  ];
  if (b.notes.length) head.push(`note: ${b.notes.join("; ")}`);
  if (b.integrationError?.length) head.push(`error: ${b.integrationError[0]}`, ...b.integrationError.slice(1));
  const chunks = fix ? [renderJob(fix)] : [];
  sorted.forEach((j, i) => {
    if (j.status === "RUNNING" && sorted[i - 1]?.status === "RUNNING") chunks[chunks.length - 1] += `\n${renderJob(j)}`;
    else chunks.push(renderJob(j));
  });
  const blocked = sorted.find((j) => j.status === "BLOCKED");
  const next = [
    blocked && `reply(job="${blocked.job}", ...)`,
    (b.integration === "running" || sorted.some((j) => j.status === "BLOCKED" || j.status === "RUNNING")) && `jobs(action="wait", job="${b.batch}")`,
  ].filter(Boolean).join(" then ");
  return [head.map(fit).join("\n"), chunks.join("\n\n"), next && fit(`next: ${next}`)].filter(Boolean).join("\n");
}

/** D5 CONSENT: no job is created. */
export const renderConsent = (c: ConsentRecord) =>
  [`CONSENT repo=${c.repo}`, `send: ${c.send}`, `retention: ${c.retention}`, `approve: ${c.approve}`].map(fit).join("\n");

const oneLine = (s: string) => s.trim().replace(/\s*\n\s*/g, " ");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A line broken at spaces into lines of at most 200 chars (a longer word is left to `fit`). */
function wrap(line: string) {
  const out = [""];
  for (const word of line.replaceAll("\t", "  ").split(" ")) {
    const last = out[out.length - 1];
    if (last && last.length + 1 + word.length > LINE_MAX) out.push(word);
    else out[out.length - 1] = last ? `${last} ${word}` : word;
  }
  return out;
}

/** D9 line rules: no tabs (2 spaces), at most 200 chars with the middle elided. */
function fit(line: string) {
  const l = line.replaceAll("\t", "  ");
  if (l.length <= LINE_MAX) return l;
  const half = (LINE_MAX - 1) / 2;
  return `${l.slice(0, Math.ceil(half))}…${l.slice(l.length - Math.floor(half))}`;
}
