import { type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
/**
 * Platform: everything OS-specific lives here (spec A18). Windows is supported through junctions, taskkill and
 * PATHEXT lookup here; callers stay platform-free.
 */
/** Links a dependency directory into a worktree. Junctions need no privilege on Windows, unlike directory symlinks. */
export declare function link(target: string, path: string): void;
/** Removes a link made by `link`, never what it points to; does nothing if `path` is not a link. */
export declare function removeLink(path: string): void;
/** Forward-slash form of a relative path, as result blocks show paths. */
export declare const normalisePath: (path: string) => string;
/** Whether a process is still running (one we may not signal still counts as running). */
export declare function isAlive(pid: number): boolean;
/** How OpenCode's per-platform npm packages name this OS, and its binary's file name. */
export declare function opencodePlatform(): {
    os: string;
    binary: string;
};
/** Signals a whole process group (a child spawned `detached`), ignoring one that is already gone. */
export declare function killProcessGroup(pid: number | undefined, signal?: NodeJS.Signals): void;
/** The first executable named `name` on `env`'s PATH, or undefined. On Windows it tries PATHEXT extensions, bare name last. */
export declare function which(name: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Git for Windows' bash, for running bash-syntax commands on Windows. Never a bare `bash` from PATH: on Windows that
 * can be WSL's System32\bash.exe, which resolves Windows paths differently.
 */
export declare function gitBash(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string | undefined;
/** The first line a CLI run printed, stderr before stdout: what a failed `claude` command gets quoted as. */
export declare const firstLine: (run: SpawnSyncReturns<string> | undefined) => string;
/**
 * Runs a CLI found on the PATH. `.cmd`/`.bat` shims (claude.cmd, npx.cmd) cannot be spawned without a shell, so
 * they go through one with their args pre-quoted; everything else spawns directly. Undefined if not on the PATH.
 */
export declare function runCli(name: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> | undefined;
export declare function runCli(name: string, args: string[], opts?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer> | undefined;
