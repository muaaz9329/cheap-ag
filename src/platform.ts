import { lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { sep } from "node:path";

/**
 * Platform: everything OS-specific lives here (spec A18). POSIX only in v1; a Windows port swaps in directory
 * junctions, long-path handling and `taskkill /T` behind these same functions.
 */

export const UNSUPPORTED_REASON = "Windows not supported yet; use WSL";
export const UNSUPPORTED = `FAIL reason: ${UNSUPPORTED_REASON}`;

/** macOS and Linux (WSL reports linux) are supported; native Windows is not yet. */
export const isSupported = (platform: NodeJS.Platform = process.platform) => platform !== "win32";

/** Links a dependency directory into a worktree. */
export function link(target: string, path: string) {
  symlinkSync(target, path, "dir");
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
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}
