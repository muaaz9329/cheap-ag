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
export type JobStatus = "OK" | "PARTIAL" | "FAIL" | "BLOCKED" | "CONFLICT" | "RUNNING" | "CANCELLED" | "TIMEOUT" | "BUDGET" | "PROVIDER";
type Range = {
    path: string;
    start: number;
    end: number;
};
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
    usage: {
        turns: number;
        calls?: number;
        costUsd: number;
    };
    /** Absent when verification never ran: the headline then has no `tests=`. */
    tests?: "pass" | "fail" | "none";
    selfFix: number;
    models: {
        requested: string;
        final: string;
        escalated: boolean;
    };
    /** The de-noised tail of the last failing verify command: the command first, then indented lines. */
    error?: string[];
    /** `env`: the failing check could not run (missing tool, broken Node), so the code may still be fine. */
    check?: "env";
    tried?: string[];
    /** A stopped worker's findings note (ticket 29): where the bug is, its hypothesis, what it ruled out. */
    found?: string;
    /** `answer` is the reply sent (null while waiting); recorded, not rendered. */
    question?: {
        text: string;
        options: string[];
        answer?: string | null;
    } | null;
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
    usage: {
        turns: number;
        calls?: number;
        costUsd: number;
    };
    models?: {
        requested: string;
        final: string;
    };
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
export type ConsentRecord = {
    repo: string;
    send: string;
    retention: string;
    approve: string;
};
/** The summary a worker that never reported gets (src/worker.ts). */
export declare const NO_SUMMARY = "(worker gave no summary)";
/** A FAIL before any job exists (bad input, setup). */
export declare const failBlock: (reason: string) => string;
/** The three lettered options a permission block offers; letter "b" names the prefix the server would save. */
export declare const permissionOptions: (prefix: string) => string[];
/** A job block within `budget` tokens (chars/4), cutting in D9 order only while over it. Never cut: headline, question/options, conflict, reason, worktree, log. */
export declare function renderJob(r: JobRecord, budget?: number, compact?: boolean): string;
/** D7. A research CONSENT renders through `renderConsent`. */
export declare function renderResearch(r: ResearchRecord): string;
/**
 * D6: header, notes, integration error, the integration fix job's block, then job blocks by urgency (RUNNING ones as
 * adjacent single lines), then `next:`. The fix job is not a group: it counts in the cost only.
 */
export declare function renderBatch(b: BatchRecord, jobs: JobRecord[], fix?: JobRecord): string;
/** D5 CONSENT: no job is created. */
export declare const renderConsent: (c: ConsentRecord) => string;
export {};
