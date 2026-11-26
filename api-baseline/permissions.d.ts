/**
 * The worker's permission ruleset (spec E1, A12). Verified against OpenCode 1.19.0 with a scripted model:
 * - rules passed to `session.create` are enforced, the last matching rule winning; an agent file's `permission:`
 *   frontmatter is NOT applied, so the ruleset goes on every worker session;
 * - `OPENCODE_PERMISSION` (the server-wide baseline) applies too, but a session rule overrides it, so the session
 *   ruleset itself ends with the hard denylist;
 * - edit patterns are worktree-relative and cannot deny an absolute path outside it, so `external_directory` stays
 *   denied: linked dependency dirs are read through their in-worktree symlink, and edits under them are denied.
 * - OpenCode splits `;`, `|`, `&&`, `$(…)` and backticks into separate checked commands, but not redirection, so
 *   `>` is denied outright except the known stderr forms on already-allowed commands (below).
 *
 * This is a guardrail against commands the model types, not a sandbox: the worker can edit source and run allowed
 * test commands, so code it writes can still run anything the developer's user can (see STATUS carry-forward).
 */
export type Rule = {
    permission: string;
    pattern: string;
    action: "allow" | "deny" | "ask";
};
/**
 * Programs whose "always allow" prefix could write files or run arbitrary code: `sed -i`, awk/perl/python `system`,
 * `find -exec`, and the rest would get past the edit rules that protect .env, lockfiles and cheapag.json. They may
 * still be allowed once, never always.
 */
export declare const WRITE_OR_RUN: Set<string>;
/** Whether "always allow" may be offered for a command's prefix. */
export declare const canAlwaysAllow: (prefix: string) => boolean;
/** Commands no project script or config may allow: always the last rules, so they always win. */
export declare const HARD_DENY: string[];
/** Paths the worker may never edit: git internals, Cheap Agent state, env files, lockfiles. */
export declare const PROTECTED: string[];
/**
 * The full ruleset for one worker session: catch-all deny first, then explicit allows and denies for every key,
 * then the hard denylist. `scripts` and `allowCommands` are allowed with any arguments; `exact` only as written
 * (make targets, the step's done-when checks); `linked` are dependency dirs in the worktree (readable, never editable).
 */
export declare function workerRuleset(opts?: {
    scripts?: string[];
    exact?: string[];
    allowCommands?: string[];
    linked?: string[];
    onBlockedCommand?: "ask" | "deny";
}): Rule[];
/**
 * The research worker's ruleset (spec E1, research; ticket 23.4): read, search, and run the same test commands as the
 * implementation worker (to reproduce a failure it is asked about), never edit. It runs in a throwaway worktree (src/research.ts),
 * so a command that writes files cannot touch the developer's tree. Env files are unreadable; outside the repo is denied.
 */
export declare function researchRuleset(opts?: {
    scripts?: string[];
    exact?: string[];
    allowCommands?: string[];
}): Rule[];
/** The same static rules in OpenCode's config form, for the server-wide `OPENCODE_PERMISSION` baseline. */
export declare function baselinePermission(): Record<string, string | Record<string, string>>;
/**
 * The project's own runnable scripts: package.json scripts under each package manager (`scripts`, arguments allowed)
 * and make targets (`exact`: `make -f`/`--eval` would run anything). Names with spaces or wildcards are skipped.
 */
export declare function projectScripts(dir: string): {
    scripts: string[];
    exact: string[];
};
/** The program a command names, plus a bare second word (`git branch`, `npm run`), for an "always allow" prefix. */
export declare function commandPrefix(command: string): string;
/** Whether any part of a command is on `HARD_DENY`: those are refused, never put to the user. */
export declare function isHardDenied(command: string): boolean;
/** What a worker sees when a permission request is auto-rejected (spec E1). */
export declare const rejectionMessage: (what: string) => string;
