import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isAlive, link, normalisePath, removeLink } from "./platform.js";

/** Workspace (ADR-0003): baseline, worktree per job, diff, and landing; the only writer to the user's tree. */

export type Changed = { status: string; path: string; add: number; del: number };

// Git for Windows refuses paths over 260 chars unless long paths are on; the flag is a no-op elsewhere
const GIT_ARGS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

export function git(cwd: string, args: string[], env?: Record<string, string>) {
  return execFileSync("git", [...GIT_ARGS, ...args], { cwd, stdio: "pipe", env: env && { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 }).toString();
}

/** The repository root containing `cwd`; throws when it is not a git repository. */
export function projectRoot(cwd: string) {
  try {
    // resolved: git prints forward slashes on Windows (C:/x/y); path.* gives the platform's own separators
    return resolve(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
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
  git(path, ["add", "-A", "--", ".", ...outside(notIgnored(path, linked))]);
  const base = git(path, ["write-tree"]).trim();
  return { path, head, stash, base, links, linked };
}

function discard(root: string, path: string, links: string[]) {
  for (const l of links) removeLink(l); // unlink first, so nothing can reach through into the real dirs
  try {
    git(root, ["worktree", "remove", "--force", path]);
  } catch {
    // git no longer knows it (pruned by hand): rm never follows symlinks.
    // OpenCode releases a disposed directory's handles asynchronously, and Windows refuses to
    // delete a directory that is still open; rmSync only retries EBUSY/EPERM-type errors.
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    git(root, ["worktree", "prune"]);
  }
}

/** Pathspecs that keep Cheap Agent's state and the given dependency dirs out of a git operation. */
const outside = (dirs: string[]) => [".cheapag", ...dirs].map((d) => `:(exclude,top,literal)${d}`);

// git 2.55 rejects a pathspec naming an ignored path, even as an exclusion; an already-ignored dir needs no exclusion
const notIgnored = (dir: string, paths: string[]) =>
  paths.filter((p) => spawnSync("git", [...GIT_ARGS, "check-ignore", "-q", "--", p], { cwd: dir, stdio: "pipe" }).status !== 0);

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
  git(path, ["add", "-A", "--", ".", ...outside(notIgnored(path, worktree.linked))]);
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

/** How long landing waits for another holder. `CHEAPAG_LOCK_TIMEOUT_MS` is a test hook (like CHEAPAG_OPENCODE_URL), not a setting. */
const lockTimeoutMs = () => Number(process.env.CHEAPAG_LOCK_TIMEOUT_MS) || 10 * 60_000;

/** What `.cheapag/land.lock` holds. `token` tells one holder's lock from the next one's (absent in older locks). */
type Holder = { pid: number; at: string; token?: string };

/** Serialises landing and integration checks across Cheap Agent processes on one project: `.cheapag/land.lock` holds pid + timestamp + token. */
export async function withLock<T>(root: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = join(root, ".cheapag", "land.lock");
  const token = randomBytes(8).toString("hex");
  // unique per call: parallel groups in one process wait on the lock at once, and must not delete each other's file
  const mine = `${lock}.${process.pid}.${token}`;
  mkdirSync(join(root, ".cheapag"), { recursive: true });
  // written whole, then hard-linked into place: the lock never exists without its contents
  writeFileSync(mine, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token } satisfies Holder));
  const timeout = lockTimeoutMs();
  const deadline = Date.now() + timeout;
  try {
    for (;;) {
      try {
        linkSync(mine, lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readHolder(lock); // gone: released meanwhile, so try again at once
      if (!holder) continue;
      if (!(holder.pid > 0 && isAlive(holder.pid))) breakStale(lock, holder);
      else if (Date.now() > deadline) {
        const waited = timeout >= 60_000 ? `${Math.round(timeout / 60_000)} min` : `${timeout / 1000} s`;
        throw new Error(`timed out after ${waited} waiting for .cheapag/land.lock (held by pid ${holder.pid} since ${holder.at}); try again once it is released`);
      } else await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    rmSync(mine, { force: true });
  }
  try {
    return await fn();
  } finally {
    // only our own: never a lock someone else holds now
    if (readHolder(lock)?.token === token) rmSync(lock, { force: true });
  }
}

/**
 * Removes a lock whose holder is dead. The rename (to a name of our own) lets only one waiter break it. Between reading
 * the dead holder and renaming, another waiter may have broken it and a live process taken it: then that lock goes back.
 */
function breakStale(lock: string, dead: Holder) {
  const stale = `${lock}.stale.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lock, stale);
  } catch {
    return; // another waiter already broke it
  }
  if (readHolder(stale)?.token !== dead.token) {
    try {
      linkSync(stale, lock);
    } catch {
      // shortcut: a third process took the free name in the instant before the put-back, so two hold it; needs OS file locks (flock) to close
    }
  }
  rmSync(stale, { force: true });
}

/** The lock's holder, or undefined when the file is gone. */
function readHolder(file: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as Holder;
  } catch {
    return { pid: 0, at: "unknown", token: text }; // never written partly, so not a Cheap Agent lock: no live holder
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
      // shortcut: the lock does not stop the developer's editor; an edit to these files in the milliseconds since the check
      // could still leave markers here. Upgrade by applying with --cached to the throwaway index and checking out its paths.
      const applied = applyOutput(root, ["apply", "--3way", "-"], env, patch);
      return applied.failed ? applied.output.trim() : undefined;
    } finally {
      rmSync(index, { force: true });
    }
  });
}

/** git apply's verdict lives in stderr even when it exits 0. */
function applyOutput(root: string, args: string[], env: Record<string, string>, patch: string) {
  const r = spawnSync("git", [...GIT_ARGS, ...args], { cwd: root, env: { ...process.env, ...env }, input: patch, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { failed: r.status !== 0, output: `${r.stdout}${r.stderr}` };
}

/** The paths a failed landing names as conflicting, from git apply's messages. */
export function conflictPaths(text: string) {
  const named = [...text.matchAll(/^Applied patch to '(.+)' with conflicts\.$|^error: (.+?): (?:does not exist in index|does not match index|already exists in (?:index|working directory)|patch does not apply)$/gm)];
  return [...new Set(named.map((m) => m[1] ?? m[2]))];
}

/**
 * For a redo: 3-way applies a job's earlier patch onto its fresh worktree, so clashing hunks are left there as conflict
 * markers for the worker to reconcile. Returns the paths left conflicted. Only the worktree (and its own index) changes.
 */
export function reapply(worktree: Worktree, patch: string) {
  applyOutput(worktree.path, ["apply", "--3way", "-"], {}, patch); // a patch that cannot apply at all leaves the worktree as it was
  return git(worktree.path, ["diff", "--name-only", "-z", "--diff-filter=U"]).split("\0").filter(Boolean);
}

/** Paths whose changes still add conflict marker lines; run after `worktreeDiff`, which stages the worktree. */
export function leftoverMarkers(worktree: Worktree) {
  const r = spawnSync("git", [...GIT_ARGS, "diff", "--cached", "--check", worktree.base], { cwd: worktree.path, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return [...new Set([...r.stdout.matchAll(/^(.+?):\d+: leftover conflict marker$/gm)].map((m) => m[1]))];
}

/**
 * The worktree a finished job left behind, for `land`: always `.cheapag/worktrees/<job>` (never a path read from a
 * record), and only a real directory. The `linkDirs` entries that are links in it are its dependency links.
 */
export function jobWorktree(root: string, job: string, base: string, linkDirs: string[]): Worktree | undefined {
  const path = join(root, ".cheapag", "worktrees", job);
  if (!lstatOf(path)?.isDirectory()) return undefined;
  const links = linkDirs.map((d) => join(path, d)).filter((l) => lstatOf(l)?.isSymbolicLink());
  return { path, head: "", stash: null, base, links, linked: links.map((l) => normalisePath(relative(path, l))) };
}

const lstatOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
