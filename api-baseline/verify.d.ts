/** Verify: runs a job's executable done conditions in its worktree and condenses failures into an error tail. */
export type VerifyRun = {
    cmd: string;
    ok: boolean;
    ms: number;
    output: string;
    code: number | null;
    signal: string | null;
};
/** The backticked fragments of each step's `done-when`, in order; else the configured test_cmd; else none. */
export declare function verifyCommands(doneWhen: string[], testCmd?: string): string[];
/**
 * Every string the ruleset must allow for one check command, so the worker can run it as written: the command
 * itself, plus each `&&`/`||`/`;`/`|` segment (OpenCode checks segments separately), each as typed and with its
 * leading `NAME=value` (or `export NAME=value`) assignments stripped. De-duplicated, in first-seen order.
 */
export declare function checkAllows(cmd: string): string[];
/**
 * Runs the commands in order in `cwd`, stopping at the first failure; `onStart` hears each command as it begins.
 * Aborting `signal` kills the running command's process group (cap or cancel) and fails it.
 */
export declare function runVerify(cwd: string, cmds: string[], onStart: (cmd: string) => void, signal?: AbortSignal): Promise<VerifyRun[]>;
/**
 * Why a failed check looks environmental (a missing tool or a broken Node) rather than a failing test: the exit code,
 * the signal, or a phrase only a shell or loader emits. `undefined` when the run passed or failed like ordinary code.
 */
export declare function envFailure(run: VerifyRun): string | undefined;
/**
 * Spec D9: the failing command, then up to 3 distinct failures (similar ones counted ×N), each with its message,
 * expected/received lines and first in-repo frame; at most 25 lines of 200 chars, with `root` made repo-relative.
 * Falls back to the last lines when no failure marker is found.
 */
export declare function errorTail(run: VerifyRun, root: string): string[];
/** Whether two tails show the same failure, ignoring numbers (timings, counts, ports). */
export declare const sameFailure: (a: string[], b: string[]) => boolean;
