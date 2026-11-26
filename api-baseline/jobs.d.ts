import { type Provider } from "./credentials.js";
import { type Opencode } from "./opencode.js";
import { type JobRecord, type PermissionBlock } from "./report.js";
import { type Difficulty, type Route } from "./routing.js";
import { type Question } from "./worker.js";
import { type Changed } from "./workspace.js";
/**
 * `brief`: a research scout brief (ticket 23.4), resolved to its text, handed to every worker of the delegation.
 * `source`: the user's request or the issue, verbatim (ticket 28), so the worker can check the step against it.
 */
export type DelegateInput = {
    plan: string;
    steps: string;
    note?: string;
    wait?: boolean;
    brief?: string;
    source?: string;
    difficulty?: Difficulty;
    model?: string;
};
/** What the tool takes: a plan file and steps, or (one step, no plan file) an inline task with optional files and done-when. */
export type DelegateRequest = Partial<DelegateInput> & {
    task?: string;
    files?: string;
    done_when?: string;
    root?: string;
};
/** What a tool call that may start workers gets from the server. */
export type WorkerContext = {
    provider: Provider;
    opencode: (route: Route) => Promise<Opencode>;
    progress: Progress;
};
export declare function delegate(req: DelegateRequest, ctx: WorkerContext): Promise<string>;
/** Compresses a settled job's (or research call's) events.jsonl; any error is ignored, nothing depends on it. */
export declare function gzipEvents(dir: string): void;
export type JobsInput = {
    action: "list" | "show" | "wait" | "cancel";
    job?: string;
    seconds?: number;
    root?: string;
};
/** The `jobs` tool: list jobs, show one's last block again, wait for a job's or batch's next settlement, or cancel a running job. */
export declare function jobs(input: JobsInput, progress?: Progress): Promise<string>;
type StoredRecord = JobRecord & {
    pid?: number;
    batch?: string | null;
    timing?: {
        startedAt?: string;
        endedAt?: string | null;
        blockedAt?: string;
    };
    baseline?: {
        tree?: string | null;
    };
    discarded?: boolean;
};
/** How long a BLOCKED job has waited for a reply, as a suffix for its one-line headline (jobs list, cheapag status). */
export declare const blockedFor: (r: StoredRecord) => string;
/** Every readable job record in the project, with the folder it lives in. */
export declare function records(root: string): {
    format: "cheapag/1";
    job: string;
    status: import("./report.js").JobStatus;
    landed: boolean;
    steps: string;
    summary: string;
    changed: Changed[];
    risks: string[];
    review: {
        path: string;
        start: number;
        end: number;
    }[];
    missing: string[];
    reason?: string;
    worktree: string | null;
    cleanupError?: string;
    usage: {
        turns: number;
        calls?: number;
        costUsd: number;
    };
    tests?: "pass" | "fail" | "none";
    selfFix: number;
    models: {
        requested: string;
        final: string;
        escalated: boolean;
    };
    error?: string[];
    check?: "env";
    tried?: string[];
    found?: string;
    question?: {
        text: string;
        options: string[];
        answer?: string | null;
    } | null;
    questions?: NonNullable<JobRecord["question"]>[];
    permission?: PermissionBlock | null;
    conflict?: string[];
    redo?: number | null;
    billing?: "zen";
    repro?: "fail→pass" | "unverified" | "none";
    test?: string;
    pid?: number;
    batch?: string | null;
    timing?: {
        startedAt?: string;
        endedAt?: string | null;
        blockedAt?: string;
    };
    baseline?: {
        tree?: string | null;
    };
    discarded?: boolean;
    dir: string;
}[];
/** The project's job records, newest first by start time. */
export declare const newestFirst: (root: string) => {
    format: "cheapag/1";
    job: string;
    status: import("./report.js").JobStatus;
    landed: boolean;
    steps: string;
    summary: string;
    changed: Changed[];
    risks: string[];
    review: {
        path: string;
        start: number;
        end: number;
    }[];
    missing: string[];
    reason?: string;
    worktree: string | null;
    cleanupError?: string;
    usage: {
        turns: number;
        calls?: number;
        costUsd: number;
    };
    tests?: "pass" | "fail" | "none";
    selfFix: number;
    models: {
        requested: string;
        final: string;
        escalated: boolean;
    };
    error?: string[];
    check?: "env";
    tried?: string[];
    found?: string;
    question?: {
        text: string;
        options: string[];
        answer?: string | null;
    } | null;
    questions?: NonNullable<JobRecord["question"]>[];
    permission?: PermissionBlock | null;
    conflict?: string[];
    redo?: number | null;
    billing?: "zen";
    repro?: "fail→pass" | "unverified" | "none";
    test?: string;
    pid?: number;
    batch?: string | null;
    timing?: {
        startedAt?: string;
        endedAt?: string | null;
        blockedAt?: string;
    };
    baseline?: {
        tree?: string | null;
    };
    discarded?: boolean;
    dir: string;
}[];
/**
 * Crash recovery at server start (spec: Job lifecycle, restart): a RUNNING or BLOCKED job whose server process is gone
 * becomes CANCELLED with `reason: server restart`; its worktree is kept.
 */
export declare function recoverJobs(cwd: string): void;
export type LandInput = {
    job: string;
    action: "apply" | "discard";
    root?: string;
};
/**
 * The `land` tool (spec: Tool contracts, A13): `apply` 3-way applies unlanded jobs' worktree changes to the working
 * tree under the lock, in the order given, stopping at the first that fails; `discard` deletes their worktrees. One line
 * per job. Records are updated (`landed`, `worktree`, `discarded`) so research's unlanded note and cleanup stay truthful.
 */
export declare function landJobs(input: LandInput, ctx: WorkerContext): Promise<string>;
/** A job paused on a worker question. It lives only in this process, as does its paused session. */
export type BlockedJob = {
    job: string;
    /** The repository the job runs in: ids are unique per repository, and one server can run jobs in several. */
    root: string;
    questions: Question[];
    /** A command permission ask: only the letters a, b, c answer it (a and c when always-allow is not offered). */
    permission?: boolean;
    /** Whether the block offered "always allow"; false means b is not an answer. */
    always?: boolean;
    /** Answers the questions (one answer each) and resumes the session; resolves with the job's next block (final, or BLOCKED again). */
    resume: (answers: string[], progress: Progress) => Promise<string>;
};
type Progress = (turns: number, message: string) => void;
/** The jobs waiting for a reply right now, by job id (for the jobs tool and a batch's early return). */
export declare const blockedJobs: () => ReadonlyMap<string, BlockedJob>;
/** `reply`: a letter picks that option's label, anything else is passed through as free text (spec D8). */
export declare function reply(input: {
    job: string;
    answer: string;
    root?: string;
}, progress: Progress): Promise<string>;
/** `prefix` + 4 base36 chars: a job (`j`), batch (`b`) or research (`r`) id. */
export declare const newId: (prefix: string) => string;
export {};
