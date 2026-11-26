import { type Event } from "@opencode-ai/sdk/v2";
import { type Opencode } from "./opencode.js";
import { type Rule } from "./permissions.js";
import { type Limit, type WorkerModel } from "./routing.js";
/** Worker: one OpenCode session for one job, reduced to what the job layer needs. */
export declare const WORKER_AGENT = "cheapag-worker";
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
export type Rejection = {
    kind: "denied" | "asked";
    permission: string;
    what: string;
};
export type SessionResult = SessionTotals & RunResult;
/** A question the worker asked with OpenCode's question tool: its text and option labels, in order. */
export type Question = {
    question: string;
    options: string[];
};
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
/**
 * Opens one worker session. `run` prompts it (optionally on another model, e.g. escalation) and resolves when the
 * session goes idle; self-fixes and escalation are further `run`s of the same session.
 */
export declare function openSession(opts: {
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
    step?: {
        label: string;
        title: string;
    };
    /** Aborting it aborts the session's current prompt (OpenCode abort) and refuses later ones: caps and cancel. */
    signal?: AbortSignal;
}): Promise<{
    readonly sessionID: string;
    run: (prompt: string, model?: WorkerModel, interrupt?: AbortSignal, afterStop?: boolean) => Promise<RunResult>;
    rotate: () => Promise<boolean>;
    totals: () => SessionTotals;
}>;
export type Session = Awaited<ReturnType<typeof openSession>>;
/**
 * Disposes the OpenCode instance for `directory`: nothing it still holds open then keeps the directory from being
 * removed (Windows cannot delete one), and a long-lived server does not keep a watcher per past job. Best effort:
 * no running server, or any error, changes nothing.
 */
export declare function releaseDirectory(directory: string): Promise<void>;
/** One prompt in a fresh session (the login live check). */
export declare function runSession(opts: Parameters<typeof openSession>[0] & {
    prompt: string;
}): Promise<SessionResult>;
/** The finish tool's report; else the last fenced `cheapag-result` block, parsed leniently; else a placeholder. */
export declare function finishReport(result: Pick<SessionResult, "finish" | "text">): FinishReport;
