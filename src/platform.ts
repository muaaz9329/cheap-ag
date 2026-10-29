import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

/**
 * Platform: everything OS-specific lives here (spec A18). Windows is supported through junctions, taskkill and
 * PATHEXT lookup here; callers stay platform-free.
 */

/** Links a dependency directory into a worktree. Junctions need no privilege on Windows, unlike directory symlinks. */
export function link(target: string, path: string) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Removes a link made by `link`, never what it points to; does nothing if `path` is not a link. */
export function removeLink(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Forward-slash form of a relative path, as result blocks show paths. */
export const normalisePath = (path: string) => path.split(sep).join("/");

/** Whether a process is still running (one we may not signal still counts as running). */
export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How OpenCode's per-platform npm packages name this OS, and its binary's file name. */
export function opencodePlatform() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return { os, binary: os === "windows" ? "opencode.exe" : "opencode" };
}

/** Signals a whole process group (a child spawned `detached`), ignoring one that is already gone. */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid) return;
  if (process.platform === "win32") {
    // no process groups on Windows; taskkill walks the tree instead and ignores the signal
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** The first executable named `name` on `env`'s PATH, or undefined. On Windows it tries PATHEXT extensions, bare name last. */
export function which(name: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = platform === "win32"
    ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => name + ext), name]
    : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      if (platform !== "win32") {
        const full = join(dir, candidate);
        if (existsSync(full)) return full;
        continue;
      }
      // Windows filesystems are case-insensitive; read the dir so a case difference still matches
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        break;
      }
      const hit = entries.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
      if (hit) return join(dir, hit);
    }
  }
  return undefined;
}

/**
 * Git for Windows' bash, for running bash-syntax commands on Windows. Never a bare `bash` from PATH: on Windows that
 * can be WSL's System32\bash.exe, which resolves Windows paths differently.
 */
export function gitBash(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform !== "win32") return undefined;
  // Claude Code's own variable; trust it when it points at a real file
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && existsSync(override)) return override;
  const git = which("git", platform, env);
  if (!git) return undefined;
  // Git for Windows: git.exe in <Git>\cmd, bash.exe in <Git>\bin
  const bash = join(dirname(git), "..", "bin", "bash.exe");
  return existsSync(bash) ? bash : undefined;
}

/** Double-quotes an argument Node will re-split under `shell: true` on Windows. */
const quoteWinArg = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/**
 * Runs a CLI found on the PATH. `.cmd`/`.bat` shims (claude.cmd, npx.cmd) cannot be spawned without a shell, so
 * they go through one with their args pre-quoted; everything else spawns directly. Undefined if not on the PATH.
 */
export function runCli(name: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> | undefined;
export function runCli(name: string, args: string[], opts?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer> | undefined;
export function runCli(name: string, args: string[], opts?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> | undefined {
  const file = which(name);
  if (!file) return undefined;
  if (/\.(cmd|bat)$/i.test(file)) {
    return spawnSync(file, args.map(quoteWinArg), { ...opts, shell: true, windowsHide: true });
  }
  return spawnSync(file, args, opts);
}
