/** Workspace (ADR-0003): baseline, worktree per job, diff, and landing; the only writer to the user's tree. */
export type Changed = {
    status: string;
    path: string;
    add: number;
    del: number;
};
export declare function git(cwd: string, args: string[], env?: Record<string, string>): string;
/** The repository root containing `cwd`; throws when it is not a git repository. */
export declare function projectRoot(cwd: string): string;
/**
 * The repository a tool call works in: its `root` argument when given, else the server's cwd. An orchestrator session
 * passes `root` to send jobs into a git worktree other than the one it started in; it must be absolute, so it never
 * depends on the server's cwd.
 */
export declare function callRoot(root?: string): string;
/** Whether the repository has at least one commit: a fresh `git init` has none, so HEAD cannot be resolved. */
export declare function hasCommits(root: string): boolean;
/** What a job's worktree was started from; `base` is the tree its diff (and so its landing) is measured against. */
export type Worktree = {
    path: string;
    head: string;
    stash: string | null;
    base: string;
    links: string[];
    linked: string[];
};
/**
 * A detached worktree under `.cheapag/worktrees/<job>` holding the developer's current state (ADR-0003):
 * HEAD, plus uncommitted tracked changes (a `git stash create` snapshot, which leaves the checkout and the stash list
 * alone), plus copies of untracked non-ignored files such as a freshly written plan. Dependency directories from
 * `linkDirs` are linked in from the main checkout. Nothing in the main checkout is modified.
 */
export declare function createWorktree(root: string, job: string, linkDirs: string[]): Worktree;
/** Everything the job changed relative to its baseline tree, as a binary patch plus per-file stats. */
export declare function worktreeDiff(worktree: Worktree): {
    patch: string;
    changed: Changed[];
};
/** Why the checkout cannot be a job's starting point right now (a merge, rebase… or unresolved conflicts), if it cannot. */
export declare function operationInProgress(root: string): string | undefined;
export declare function removeWorktree(root: string, worktree: Worktree): void;
/** Serialises landing and integration checks across Cheap Agent processes on one project: `.cheapag/land.lock` holds pid + timestamp + token. */
export declare function withLock<T>(root: string, fn: () => T | Promise<T>): Promise<T>;
/**
 * 3-way applies `patch` to the user's working tree, uncommitted and leaving their index alone.
 * Runs against a throwaway index synced to the working tree, so their unstaged edits are the merge base side.
 * Returns undefined on success, or the conflict text with the tree untouched.
 */
export declare function land(root: string, job: string, patch: string, paths: string[]): Promise<string | undefined>;
/** The paths a failed landing names as conflicting, from git apply's messages. */
export declare function conflictPaths(text: string): string[];
/**
 * For a redo: 3-way applies a job's earlier patch onto its fresh worktree, so clashing hunks are left there as conflict
 * markers for the worker to reconcile. Returns the paths left conflicted. Only the worktree (and its own index) changes.
 */
export declare function reapply(worktree: Worktree, patch: string): string[];
/** Paths whose changes still add conflict marker lines; run after `worktreeDiff`, which stages the worktree. */
export declare function leftoverMarkers(worktree: Worktree): string[];
/**
 * The worktree a finished job left behind, for `land`: always `.cheapag/worktrees/<job>` (never a path read from a
 * record), and only a real directory. The `linkDirs` entries that are links in it are its dependency links.
 */
export declare function jobWorktree(root: string, job: string, base: string, linkDirs: string[]): Worktree | undefined;
