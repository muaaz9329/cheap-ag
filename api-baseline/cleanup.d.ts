import { type Config } from "./config.js";
export type Cleaned = {
    removed: string[];
    kept: string[];
};
export declare function cleanup(root: string, retention: Config["retention"], linkDirs: string[], opts?: {
    all?: boolean;
    now?: number;
}): Cleaned;
/**
 * Re-runs cleanup every `everyMs` while the server lives (ticket 49): an unref'ed timer, and every error is logged to
 * stderr in one line so housekeeping can never crash or keep the process alive. Never touches an in-flight job.
 */
export declare function startPeriodicCleanup(root: string, config: Config, everyMs: number): NodeJS.Timeout;
/** Cleans the repo containing `cwd` with its configured retention (throws on a bad config or outside a repo). */
export declare function cleanProject(cwd: string, all?: boolean): Cleaned;
/** `cheapag clean [--all]`: non-interactive, so the plugin's `/cheapag:clean` can wrap it; prints what went and what stayed. */
export declare function clean(args: string[]): number;
/** A one-line offer to gitignore `.cheapag/` when the repo containing `cwd` does not ignore it (spec E5); never edits .gitignore. */
export declare function gitignoreHint(cwd: string): "hint: .cheapag/ (Cheap Agent's runtime state) is not gitignored; add a `.cheapag/` line to .gitignore so it is never committed" | undefined;
