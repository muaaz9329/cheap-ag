import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Workspace (ADR-0003): baseline, worktree per job, diff, and landing; the only writer to the user's tree. */

export type Changed = { status: string; path: string; add: number; del: number };

export function git(cwd: string, args: string[], env?: Record<string, string>) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: env && { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 }).toString();
}

/** The repository root containing `cwd`; throws when it is not a git repository. */
export function projectRoot(cwd: string) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git repository`);
  }
}

/** A detached worktree at the current HEAD under `.cheapag/worktrees/<job>`. */
export function createWorktree(root: string, job: string) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const path = join(root, ".cheapag", "worktrees", job);
  git(root, ["worktree", "add", "--detach", path, head]);
  return { head, path };
}

/** Everything the job changed relative to its baseline, as a binary patch plus per-file stats. */
export function worktreeDiff(path: string, head: string) {
  git(path, ["add", "-A"]); // the worktree's own index: throwaway, never committed
  const patch = git(path, ["diff", "--cached", "--binary", head]);
  const stats = git(path, ["diff", "--cached", "--numstat", "-z", "--no-renames", head]).split("\0").filter(Boolean);
  const statuses = new Map<string, string>();
  const names = git(path, ["diff", "--cached", "--name-status", "-z", "--no-renames", head]).split("\0").filter(Boolean);
  for (let i = 0; i < names.length; i += 2) statuses.set(names[i + 1], names[i]);
  const changed: Changed[] = stats.map((line) => {
    const [add, del, file] = line.split("\t");
    // binary files report "-" for both counts
    return { status: statuses.get(file) ?? "M", path: file, add: Number(add) || 0, del: Number(del) || 0 };
  });
  return { patch, changed };
}

export function removeWorktree(root: string, path: string) {
  git(root, ["worktree", "remove", "--force", path]);
}

const LOCK_TIMEOUT_MS = 10 * 60_000;

/** Serialises landing across Cheap Agent processes on one project: `.cheapag/land.lock` holds pid + timestamp. */
async function withLock<T>(root: string, fn: () => T): Promise<T> {
  const lock = join(root, ".cheapag", "land.lock");
  const mine = `${lock}.${process.pid}`;
  mkdirSync(join(root, ".cheapag"), { recursive: true });
  // written whole, then hard-linked into place: the lock never exists without its contents
  writeFileSync(mine, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        linkSync(mine, lock);
        break;
      } catch {
        // shortcut: two waiters can both see a dead holder; rename makes only one break it, but a waiter that
        // read the old holder just before a new one took the lock can still remove it. Fine for one Claude session per project.
        if (holderDead(lock)) rmSync(renameAway(lock), { force: true });
        else if (Date.now() > deadline) throw new Error("timed out after 10 min waiting for .cheapag/land.lock");
        else await new Promise((r) => setTimeout(r, 200));
      }
    }
  } finally {
    rmSync(mine, { force: true });
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function renameAway(lock: string) {
  const stale = `${lock}.stale.${process.pid}`;
  try {
    renameSync(lock, stale);
  } catch {
    // another waiter already broke it
  }
  return stale;
}

/** True when the lock's holder process is gone (or the lock vanished meanwhile). */
function holderDead(lock: string) {
  let pid: number;
  try {
    pid = (JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/**
 * 3-way applies `patch` to the user's working tree, uncommitted and leaving their index alone.
 * Runs against a throwaway index synced to the working tree, so their unstaged edits are the merge base side.
 * Returns undefined on success, or the conflict text with the tree untouched.
 */
export function land(root: string, job: string, patch: string): Promise<string | undefined> {
  return withLock(root, () => {
    if (!patch.trim()) return undefined;
    const index = join(root, ".cheapag", "jobs", job, "land.index");
    copyFileSync(git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(), index);
    const env = { GIT_INDEX_FILE: index };
    try {
      git(root, ["add", "-u"], env);
      const check = applyOutput(root, ["apply", "--3way", "--check", "-"], env, patch);
      // shortcut: `apply --3way --check` exits 0 even when it would leave conflict markers, so read its message; upgrade if git changes the wording
      if (check.failed || /with conflicts/.test(check.output)) return check.output.trim() || "patch does not apply";
      const applied = applyOutput(root, ["apply", "--3way", "-"], env, patch);
      return applied.failed ? applied.output.trim() : undefined;
    } finally {
      rmSync(index, { force: true });
    }
  });
}

/** git apply's verdict lives in stderr even when it exits 0. */
function applyOutput(root: string, args: string[], env: Record<string, string>, patch: string) {
  const r = spawnSync("git", args, { cwd: root, env: { ...process.env, ...env }, input: patch, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { failed: r.status !== 0, output: `${r.stdout}${r.stderr}` };
}
