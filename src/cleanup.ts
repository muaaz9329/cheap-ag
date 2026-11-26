import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { redact } from "./credentials.js";
import { recoverJobs } from "./jobs.js";
import { isAlive, removeLink } from "./platform.js";
import { git, projectRoot } from "./workspace.js";

/**
 * Cleanup (spec: Concurrency, platform, cleanup; A20), part of the Workspace module: at server start and on
 * `cheapag clean`. Unlanded worktrees go after `retention.unlanded_worktree_days`, job folders after `job_log_days`
 * (`all`: both at once). It only ever touches `.cheapag/worktrees/<id>` and `.cheapag/jobs/<id>`: consent.json,
 * opencode/ and land.lock are never cleaned. Run `recoverJobs` first, so a crashed server's jobs age like any other.
 */

const DAY_MS = 86_400_000;
// a batch's job list becomes paths under jobs/: only names shaped like our job ids count
const JOB_ID = /^j[0-9a-z]{4}$/;
/** A job (`j…`) or research (`r…`) log folder under `.cheapag/jobs/`. */
const LOG_ID = /^[jr][0-9a-z]{4}$/;
const BATCH_FILE = /^b[0-9a-z]{4}\.json$/;
/** How long a job folder without a readable record counts as just created, so even --all leaves it alone. */
const UNKNOWN_GRACE_MS = 60 * 60_000;

export type Cleaned = { removed: string[]; kept: string[] };

/** One cleanup run: the repo and its rules, the clock, the state folders it cleans, and the report it fills in. */
type Sweep = {
  root: string;
  retention: Config["retention"];
  linkDirs: string[];
  all: boolean | undefined;
  now: number;
  jobsDir: string;
  treesDir: string;
  out: Cleaned;
};

/** What cleanup reads from a job folder's record. */
type JobRecord = {
  status?: string;
  pid?: number;
  timing?: { startedAt?: string; endedAt?: string | null };
};

export function cleanup(
  root: string,
  retention: Config["retention"],
  linkDirs: string[],
  opts: { all?: boolean; now?: number } = {},
): Cleaned {
  const now = opts.now ?? Date.now();
  const out: Cleaned = { removed: [], kept: [] };
  const state = join(root, ".cheapag");
  // a symlinked state dir (or subdir) would put what we delete outside the repo: leave it alone
  if (!isRealDirectory(state)) return out;
  const sweep: Sweep = {
    root,
    retention,
    linkDirs,
    all: opts.all,
    now,
    jobsDir: join(state, "jobs"),
    treesDir: join(state, "worktrees"),
    out,
  };
  sweepWorktrees(sweep);
  sweepJobLogs(sweep);
  sweepBatches(sweep, join(state, "batches"));
  return out;
}

/** Removes unlanded worktrees past `unlanded_worktree_days`, then prunes git's metadata for them. */
function sweepWorktrees(sweep: Sweep) {
  const limit = sweep.retention.unlanded_worktree_days;
  let removedTree = false;
  for (const id of logFolders(sweep.treesDir)) {
    // r…: a research worktree left by a crash
    const job = readJob(sweep, id);
    if (job.live) {
      sweep.out.kept.push(`worktree ${id}: ${job.status} job in flight`);
    } else if (!isOld(sweep, job.since, limit)) {
      sweep.out.kept.push(`worktree ${id}: ${ageInDays(sweep, job.since)}d old, kept ${limit}d`);
    } else {
      deleteWorktree(sweep, join(sweep.treesDir, id));
      removedTree = true;
      const reason = sweep.all ? "--all" : `unlanded, ${ageInDays(sweep, job.since)}d old`;
      sweep.out.removed.push(`worktree ${id}: ${reason}`);
    }
  }
  if (removedTree) git(sweep.root, ["worktree", "prune"]);
}

/** Deletes one worktree folder through git, else directly when git no longer knows it. */
function deleteWorktree(sweep: Sweep, path: string) {
  // unlink first, so nothing can reach through into the real dependency dirs
  for (const dir of sweep.linkDirs) removeLink(join(path, dir));
  try {
    git(sweep.root, ["worktree", "remove", "--force", path]);
  } catch {
    rmSync(path, { recursive: true, force: true }); // git no longer knows it; rm never follows symlinks
  }
}

/** Removes job and research log folders past `job_log_days`, unless in flight or explaining a kept worktree. */
function sweepJobLogs(sweep: Sweep) {
  const limit = sweep.retention.job_log_days;
  for (const id of logFolders(sweep.jobsDir)) {
    const job = readJob(sweep, id);
    if (job.live) {
      sweep.out.kept.push(`job ${id}: ${job.status} job in flight`);
    } else if (isRealDirectory(join(sweep.treesDir, id))) {
      // the record explains its worktree: it stays while the worktree does
      sweep.out.kept.push(`job ${id}: its worktree is kept`);
    } else if (!isOld(sweep, job.since, limit)) {
      sweep.out.kept.push(`job ${id}: ${ageInDays(sweep, job.since)}d old, kept ${limit}d`);
    } else {
      rmSync(join(sweep.jobsDir, id), { recursive: true, force: true });
      const reason = sweep.all ? "--all" : `${ageInDays(sweep, job.since)}d old`;
      sweep.out.removed.push(`job ${id}: ${reason}`);
    }
  }
}

/** A batch record goes with its last job folder; one that never got a job (a crashed start) goes by age. */
function sweepBatches(sweep: Sweep, batchesDir: string) {
  if (!isRealDirectory(batchesDir)) return;
  const names = readdirSync(batchesDir).filter((entry) => BATCH_FILE.test(entry));
  for (const name of names) {
    const file = join(batchesDir, name);
    const jobs = readBatchJobs(file);
    const id = name.slice(0, -".json".length);
    // its jobs say what it was: kept silently
    if (jobs.some((job) => JOB_ID.test(job) && existsSync(join(sweep.jobsDir, job)))) continue;
    const since = modifiedTime(file) ?? sweep.now;
    if (jobs.length === 0 && !isOld(sweep, since, sweep.retention.job_log_days)) continue;
    rmSync(file, { force: true });
    sweep.out.removed.push(`batch ${id}: ${batchRemovalReason(sweep, jobs, since)}`);
  }
}

/** Why a batch record went: its jobs are gone, else --all, else its age. */
function batchRemovalReason(sweep: Sweep, jobs: string[], since: number) {
  if (jobs.length) return "its jobs are gone";
  if (sweep.all) return "--all";
  return `${ageInDays(sweep, since)}d old`;
}

/**
 * Re-runs cleanup every `everyMs` while the server lives (ticket 49): an unref'ed timer, and every error is logged to
 * stderr in one line so housekeeping can never crash or keep the process alive. Never touches an in-flight job.
 */
export function startPeriodicCleanup(root: string, config: Config, everyMs: number) {
  const timer = setInterval(() => {
    try {
      cleanup(root, config.retention, config.link_dirs);
    } catch (error) {
      process.stderr.write(
        `cheapag: periodic cleanup failed: ${(error as Error).message.replace(/\s+/g, " ")}\n`,
      );
    }
  }, everyMs);
  timer.unref();
  return timer;
}

/** Cleans the repo containing `cwd` with its configured retention (throws on a bad config or outside a repo). */
export function cleanProject(cwd: string, all = false) {
  const root = projectRoot(cwd);
  const config = loadConfig(root);
  return cleanup(root, config.retention, config.link_dirs, { all });
}

/** `cheapag clean [--all]`: non-interactive, so the plugin's `/cheapag:clean` can wrap it; prints what went and what stayed. */
export function clean(args: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  if (args.length > 1 || (args.length && args[0] !== "--all")) {
    out("✗ usage: cheapag clean [--all]   (--all: remove everything not in flight)");
    return 1;
  }
  let result: Cleaned;
  try {
    recoverJobs(process.cwd()); // a crashed server's RUNNING/BLOCKED jobs become CANCELLED, then age normally
    result = cleanProject(process.cwd(), args[0] === "--all");
  } catch (error) {
    out(`✗ ${(error as Error).message}`);
    return 1;
  }
  out(`✓ removed ${result.removed.length}, kept ${result.kept.length}`);
  for (const line of result.removed) out(`  removed ${line}`);
  for (const line of result.kept) out(`  kept ${line}`);
  return 0;
}

/** A one-line offer to gitignore `.cheapag/` when the repo containing `cwd` does not ignore it (spec E5); never edits .gitignore. */
export function gitignoreHint(cwd: string) {
  try {
    git(projectRoot(cwd), ["check-ignore", "-q", ".cheapag/"]);
    return undefined;
  } catch (error) {
    // exit 1: not ignored; anything else (not a repo, git error) offers nothing
    return (error as { status?: number }).status === 1
      ? "hint: .cheapag/ (Cheap Agent's runtime state) is not gitignored; add a `.cheapag/` line to .gitignore so it is never committed"
      : undefined;
  }
}

/** Whole days from `since` to the run's clock. */
function ageInDays(sweep: Sweep, since: number) {
  return Math.floor((sweep.now - since) / DAY_MS);
}

/** Whether something dated `since` is past a rule of `limitDays` (always, under --all). */
function isOld(sweep: Sweep, since: number, limitDays: number) {
  return sweep.all || sweep.now - since >= limitDays * DAY_MS;
}

/** A job folder's record: whether it is in flight, and its age from when it ended (else started), else the folder's mtime. */
function readJob(sweep: Sweep, id: string) {
  const dir = join(sweep.jobsDir, id);
  const record = readRecord(dir, id);
  const at = recordTime(record);
  // no readable record: a job being created (or its record being rewritten) right now, unless the folder is long untouched
  const unknown = !record && sweep.now - (modifiedTime(dir) ?? 0) < UNKNOWN_GRACE_MS;
  const live = unknown || isInFlight(record);
  return {
    live,
    status: record?.status ?? (unknown ? "STARTING" : undefined),
    since: Number.isNaN(at)
      ? (modifiedTime(dir) ?? modifiedTime(join(sweep.treesDir, id)) ?? sweep.now)
      : at,
  };
}

/** A job folder's record; undefined while it has none or it is unreadable. */
function readRecord(dir: string, id: string): JobRecord | undefined {
  // research logs keep their record as research.json (never in flight across a restart: it has no RUNNING state)
  const name = id.startsWith("r") ? "research.json" : "result.json";
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    // no record (yet), or unreadable
    return undefined;
  }
}

/** When the job ended, else started, in ms; NaN when the record has neither. */
function recordTime(record: JobRecord | undefined) {
  // the record's own time, not mtime: recovery rewrites a record long after its job stopped
  return Date.parse(record?.timing?.endedAt ?? record?.timing?.startedAt ?? "");
}

/** A RUNNING or BLOCKED job whose process is still alive. */
function isInFlight(record: JobRecord | undefined) {
  return (
    (record?.status === "RUNNING" || record?.status === "BLOCKED") &&
    !!record.pid &&
    isAlive(record.pid)
  );
}

/** The job ids a batch record lists; none when it is unreadable, so it is judged by age alone. */
function readBatchJobs(file: string): string[] {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { jobs?: string[] }).jobs ?? [];
  } catch {
    // unreadable: judged by age alone
    return [];
  }
}

/** Our job and research log folders directly under `dir`, if `dir` is a real directory. */
function logFolders(dir: string) {
  if (!isRealDirectory(dir)) return [];
  return readdirSync(dir).filter((id) => LOG_ID.test(id) && isRealDirectory(join(dir, id)));
}

/** A directory that is not a symlink. */
function isRealDirectory(path: string) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** When `path` itself (not a symlink's target) last changed, in ms; undefined when it is gone. */
function modifiedTime(path: string) {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
