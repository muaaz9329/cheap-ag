/** `cheapag watch` (ticket 46): a polling live tail of this project's jobs, one line per worker turn and the verdict. */
/** What a tool call touched, for a one-line display. Never throws on a missing or odd input. */
export declare function toolTarget(tool: string, input: unknown, base?: string): string;
/** Per job dir: the byte offset already read in events.jsonl, and whether each line was printed. `skipped` marks a job that finished before watch started. */
type JobWatch = {
    offset: number;
    started: boolean;
    verdict: boolean;
    skipped: boolean;
};
/** Watch progress carried from one poll to the next. */
export type WatchState = {
    root: string;
    jobs: Map<string, JobWatch>;
};
export declare function watchState(root: string): WatchState;
/** One poll over the job dirs under `<root>/.cheapag/jobs/`, returning the lines to print since the previous call. */
export declare function scan(state: WatchState): string[];
/**
 * `cheapag watch <job…>`: follows the given jobs' progress.txt and result.txt, printing a line per change and then
 * each result. Returns 0 once every job is final. Used by Codex, which streams a running command's output live.
 */
export declare function follow(root: string, ids: string[], out?: NodeJS.WritableStream, pollMs?: number): Promise<number>;
/**
 * `cheapag watch`: prints each new line of the project's job progress, polling rather than fs.watch (Windows, and
 * worktrees are removed under a watcher). Runs until Ctrl-C.
 */
export declare function watch(root?: string, out?: NodeJS.WritableStream, pollMs?: number): Promise<never>;
export {};
