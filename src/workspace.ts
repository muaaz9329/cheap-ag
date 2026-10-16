import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isAlive, link, normalisePath, removeLink } from "./platform.js";

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

/** What a job's worktree was started from; `base` is the tree its diff (and so its landing) is measured against. */
export type Worktree = { path: string; head: string; stash: string | null; base: string; links: string[]; linked: string[] };

/**
 * A detached worktree under `.cheapag/worktrees/<job>` holding the developer's current state (ADR-0003):
 * HEAD, plus uncommitted tracked changes (a `git stash create` snapshot, which leaves the checkout and the stash list
 * alone), plus copies of untracked non-ignored files such as a freshly written plan. Dependency directories from
 * `linkDirs` are linked in from the main checkout. Nothing in the main checkout is modified.
 */
export function createWorktree(root: string, job: string, linkDirs: string[]): Worktree {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const stash = git(root, ["stash", "create"]).trim() || null;
  const path = join(root, ".cheapag", "worktrees", job);
  git(root, ["worktree", "add", "--detach", path, head]);
  const links: string[] = [];
  try {
    if (stash) git(path, ["stash", "apply", "--quiet", stash]);

    // untracked dependency dirs are linked below, never copied
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...outside(linkDirs)]).split("\0").filter(Boolean);
    // an entry ending in "/" is an untracked nested repository: not part of this repo, so not carried over
    // (git would refuse to index it, or record it as a gitlink that would then land)
    for (const file of untracked.filter((f) => !f.endsWith("/"))) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      cpSync(join(root, file), join(path, file), { verbatimSymlinks: true });
    }

    for (const dir of linkDirs) {
      const source = join(root, dir);
      const target = join(path, dir);
      // tracked dependency dirs (e.g. a committed vendor/) are already in the worktree, and stay part of the diff
      if (!isDirectory(source) || existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      link(source, target);
      links.push(target);
    }
  } catch (err) {
    discard(root, path, links);
    throw err;
  }
  const linked = links.map((l) => normalisePath(relative(path, l)));

  // the carried-over state as a tree object: the job's baseline, without committing anything
  git(path, ["add", "-A", "--", ".", ...outside(linked)]);
  const base = git(path, ["write-tree"]).trim();
  return { path, head, stash, base, links, linked };
}

function discard(root: string, path: string, links: string[]) {
  for (const l of links) removeLink(l); // unlink first, so nothing can reach through into the real dirs
  git(root, ["worktree", "remove", "--force", path]);
}

/** Pathspecs that keep Cheap Agent's state and the given dependency dirs out of a git operation. */
const outside = (dirs: string[]) => [".cheapag", ...dirs].map((d) => `:(exclude,top,literal)${d}`);

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Everything the job changed relative to its baseline tree, as a binary patch plus per-file stats. */
export function worktreeDiff(worktree: Worktree) {
  const { path, base } = worktree;
  // the worktree's own index: throwaway, never committed. A linked dir is a symlink, which a `node_modules/`
  // ignore rule does not match, so the linked ones (only those: a tracked vendor/ stays in) are excluded.
  git(path, ["add", "-A", "--", ".", ...outside(worktree.linked)]);
  const patch = git(path, ["diff", "--cached", "--binary", base]);
  const stats = git(path, ["diff", "--cached", "--numstat", "-z", "--no-renames", base]).split("\0").filter(Boolean);
  const statuses = new Map<string, string>();
  const names = git(path, ["diff", "--cached", "--name-status", "-z", "--no-renames", base]).split("\0").filter(Boolean);
  for (let i = 0; i < names.length; i += 2) statuses.set(names[i + 1], names[i]);
  const changed: Changed[] = stats.map((line) => {
    const [add, del, file] = line.split("\t");
    // binary files report "-" for both counts
    return { status: statuses.get(file) ?? "M", path: file, add: Number(add) || 0, del: Number(del) || 0 };
  });
  return { patch, changed };
}

/** Why the checkout cannot be a job's starting point right now (a merge, rebase… or unresolved conflicts), if it cannot. */
export function operationInProgress(root: string) {
  const markers = { MERGE_HEAD: "a merge", "rebase-merge": "a rebase", "rebase-apply": "a rebase", CHERRY_PICK_HEAD: "a cherry-pick", REVERT_HEAD: "a revert" };
  for (const [marker, name] of Object.entries(markers)) {
    if (existsSync(git(root, ["rev-parse", "--path-format=absolute", "--git-path", marker]).trim())) return `${name} is in progress`;
  }
  // e.g. after a conflicted `git stash pop`: no marker file, but `git stash create` would fail
  if (git(root, ["ls-files", "--unmerged"]).trim()) return "there are unresolved conflicts";
}

export function removeWorktree(root: string, worktree: Worktree) {
  discard(root, worktree.path, worktree.links);
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
  try {
    return !isAlive((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

const literal = (path: string) => `:(literal)${path}`;

/**
 * 3-way applies `patch` to the user's working tree, uncommitted and leaving their index alone.
 * Runs against a throwaway index synced to the working tree, so their unstaged edits are the merge base side.
 * Returns undefined on success, or the conflict text with the tree untouched.
 */
export function land(root: string, job: string, patch: string, paths: string[]): Promise<string | undefined> {
  return withLock(root, () => {
    if (!patch.trim()) return undefined;
    const index = join(root, ".cheapag", "jobs", job, "land.index");
    copyFileSync(git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim(), index);
    const env = { GIT_INDEX_FILE: index };
    try {
      // bring exactly the patch's paths into the throwaway index as they are on disk now, untracked files included:
      // the job's baseline had them (carry-over), so the patch expects them
      const tracked = new Set(git(root, ["ls-files", "-z", "--", ...paths.map(literal)], env).split("\0"));
      const present = paths.filter((p) => tracked.has(p) || existsSync(join(root, p)));
      if (present.length) git(root, ["add", "-A", "--", ...present.map(literal)], env);
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
