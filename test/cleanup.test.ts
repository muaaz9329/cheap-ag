import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { callText, hermeticHome, serverEntry, startServer, tempRepo } from "./harness.js";
import { createWorktree } from "../src/workspace.js";

const DAY = 86_400_000;
const deadPid = spawnSync("true").pid!; // exited: its pid is gone

/** A repo with an untracked node_modules, and Cheap Agent state that must survive any cleanup. */
function repoWithState() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo.dir, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
  mkdirSync(join(repo.dir, ".cheapag", "opencode"), { recursive: true });
  writeFileSync(join(repo.dir, ".cheapag", "consent.json"), "{}\n");
  writeFileSync(join(repo.dir, ".cheapag", "opencode", "opencode.json"), "{}\n");
  writeFileSync(join(repo.dir, ".cheapag", "land.lock"), "{}\n");
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  /** A job record `days` old (by its end time, or start time while in flight), optionally with a real worktree. */
  const job = (id: string, status: string, days: number, opts: { pid?: number; worktree?: boolean } = {}) => {
    if (opts.worktree) createWorktree(repo.dir, id, ["node_modules"]);
    const at = new Date(Date.now() - days * DAY).toISOString();
    const dir = join(repo.dir, ".cheapag", "jobs", id);
    mkdirSync(dir, { recursive: true });
    const inFlight = status === "RUNNING" || status === "BLOCKED";
    writeFileSync(join(dir, "result.json"), JSON.stringify({
      format: "cheapag/1", job: id, status, landed: status === "OK", steps: "1", summary: "", changed: [], risks: [], review: [], missing: [],
      worktree: opts.worktree ? `.cheapag/worktrees/${id}` : null, usage: { turns: 0, costUsd: 0 }, selfFix: 0,
      models: { requested: "m", final: "m", escalated: false }, pid: opts.pid ?? deadPid, timing: { startedAt: at, endedAt: inFlight ? null : at },
    }));
    writeFileSync(join(dir, "result.txt"), `${status} ${id}\n`);
  };
  const clean = (...args: string[]) => execFileSync(process.execPath, [serverEntry, "clean", ...args], { cwd: repo.dir, env, stdio: "pipe" }).toString();
  /** Output of a run expected to exit 1. */
  const failed = (...args: string[]) => {
    const r = spawnSync(process.execPath, [serverEntry, "clean", ...args], { cwd: repo.dir, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    return r.stdout;
  };
  const exists = (path: string) => existsSync(join(repo.dir, ".cheapag", path));
  const status = (id: string) => JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", id, "result.json"), "utf8")).status;
  const untouched = () => {
    expect(readFileSync(join(repo.dir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 42;\n"); // the real dependency dir
    for (const f of ["consent.json", "opencode/opencode.json", "land.lock"]) expect(exists(f)).toBe(true);
  };
  return { repo, job, clean, failed, exists, status, untouched };
}

test("cheapag clean: age rules, live jobs kept, links unlinked first, worktree metadata pruned, state files untouched", () => {
  const { repo, job, clean, exists, status, untouched } = repoWithState();
  job("jold1", "FAIL", 8, { worktree: true }); // unlanded worktree past 7 days; record still young
  job("jnew1", "FAIL", 2, { worktree: true });
  job("jlog1", "OK", 31);
  job("jlog2", "OK", 29);
  job("jrun1", "RUNNING", 60, { pid: process.pid, worktree: true }); // live: never removed, however old
  job("jblk1", "BLOCKED", 60, { pid: process.pid });
  job("jdead", "RUNNING", 10, { worktree: true }); // its server died: recovered, then aged normally
  const out = clean();
  expect(out.split("\n")[0]).toBe("✓ removed 3, kept 8");
  expect(out).toContain("  removed worktree jold1: unlanded, 8d old\n");
  expect(out).toContain("  removed job jlog1: 31d old\n");
  expect(out).toContain("  kept worktree jrun1: RUNNING job in flight\n");
  expect(out).toContain("  kept job jblk1: BLOCKED job in flight\n");
  expect(out).toContain("  kept worktree jnew1: 2d old, kept 7d\n");
  expect(exists("worktrees/jold1")).toBe(false);
  expect(exists("worktrees/jdead")).toBe(false);
  expect(exists("worktrees/jnew1/node_modules")).toBe(true);
  expect(exists("worktrees/jrun1/node_modules")).toBe(true);
  expect(exists("jobs/jlog1")).toBe(false);
  for (const id of ["jold1", "jnew1", "jlog2", "jrun1", "jblk1", "jdead"]) expect(exists(`jobs/${id}`)).toBe(true);
  expect(status("jdead")).toBe("CANCELLED");
  expect(status("jrun1")).toBe("RUNNING");
  const worktrees = repo.git("worktree", "list", "--porcelain");
  expect(worktrees).not.toMatch(/jold1|jdead/);
  expect(worktrees).toMatch(/jnew1/);
  untouched();

  // --all: everything not in flight goes
  const all = clean("--all");
  expect(all.split("\n")[0]).toBe("✓ removed 5, kept 3");
  expect(all).toContain("  removed worktree jnew1: --all\n");
  expect(exists("worktrees/jrun1/node_modules")).toBe(true);
  expect(exists("jobs/jrun1") && exists("jobs/jblk1")).toBe(true);
  expect(repo.git("worktree", "list", "--porcelain")).not.toMatch(/jnew1/);
  untouched();
});

test("a job folder without a readable record yet (being created, or mid-rewrite) survives even --all, unless long untouched", () => {
  const { repo, clean, exists } = repoWithState();
  createWorktree(repo.dir, "jnew2", ["node_modules"]);
  mkdirSync(join(repo.dir, ".cheapag", "jobs", "jnew2"), { recursive: true }); // no result.json yet
  createWorktree(repo.dir, "jgone", ["node_modules"]);
  const stale = join(repo.dir, ".cheapag", "jobs", "jgone");
  mkdirSync(stale, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(stale, twoHoursAgo, twoHoursAgo);
  const out = clean("--all");
  expect(out).toContain("  kept worktree jnew2: STARTING job in flight\n");
  expect(exists("worktrees/jnew2/node_modules") && exists("jobs/jnew2")).toBe(true);
  expect(exists("worktrees/jgone") || exists("jobs/jgone")).toBe(false);
});

test("a batch record goes with its last job folder; one that never got a job goes by age", () => {
  const { repo, job, clean, exists } = repoWithState();
  const batches = join(repo.dir, ".cheapag", "batches");
  mkdirSync(batches, { recursive: true });
  job("jold2", "OK", 40);
  job("jkeep", "OK", 1);
  const batch = (id: string, jobs: string[], ageDays = 0) => {
    writeFileSync(join(batches, `${id}.json`), JSON.stringify({ batch: id, jobs }));
    const at = new Date(Date.now() - ageDays * DAY);
    utimesSync(join(batches, `${id}.json`), at, at);
  };
  batch("bgone", ["jold2"]); // its only job is removed in this same run
  batch("bkeep", ["jold2", "jkeep"]); // still has a job folder
  batch("bnew0", [], 0); // just started, no job yet
  batch("bdead", [], 40); // a crashed start, long ago
  const out = clean();
  expect(out).toContain("  removed batch bgone: its jobs are gone\n");
  expect(out).toContain("  removed batch bdead: 40d old\n");
  expect(exists("batches/bgone.json") || exists("batches/bdead.json")).toBe(false);
  expect(exists("batches/bkeep.json") && exists("batches/bnew0.json")).toBe(true);
});

test("retention is configurable in cheapag.json, and a bad value is an error", () => {
  const { repo, job, clean, failed, exists } = repoWithState();
  job("jnew1", "FAIL", 2, { worktree: true });
  job("jlog2", "OK", 3);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ retention: { unlanded_worktree_days: 1, job_log_days: 2.5 } }));
  expect(clean().split("\n")[0]).toBe("✓ removed 2, kept 1");
  expect(exists("worktrees/jnew1")).toBe(false);
  expect(exists("jobs/jlog2")).toBe(false);
  expect(exists("jobs/jnew1")).toBe(true); // 2 days < 2.5
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ retention: { job_log_days: -1 } }));
  expect(failed()).toMatch(/^✗ .*cheapag\.json: retention\.job_log_days must be a number of days/);
  expect(failed("--force")).toMatch(/^✗ usage: cheapag clean \[--all\]/);
});

test("cleanup runs at server start, after crash recovery", async () => {
  const { repo, job, exists } = repoWithState();
  job("jlog1", "OK", 31);
  job("jdead", "BLOCKED", 40); // dead server: recovered to CANCELLED, then old enough to go
  job("jlog2", "OK", 1);
  const server = await startServer({ cwd: repo.dir });
  onTestFinished(server.close);
  expect(exists("jobs/jlog1") || exists("jobs/jdead")).toBe(false);
  expect(exists("jobs/jlog2") && exists("consent.json")).toBe(true);
});

test("gitignore hint: once per server process on the first result, and never when .cheapag/ is ignored", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, ".git", "info", "exclude"), ""); // undo the harness's ignore rule
  const server = await startServer({ cwd: repo.dir, logins: { "opencode-go": "k" } });
  onTestFinished(server.close);
  // the first result is a CONSENT block here; the hint follows it on its own line
  const first = await callText(server.client, "delegate", { plan: "p.md", steps: "1" });
  expect(first).toMatch(/^CONSENT /);
  expect(first.endsWith("\n\nhint: .cheapag/ (Cheap Agent's runtime state) is not gitignored; add a `.cheapag/` line to .gitignore so it is never committed")).toBe(true);
  expect(await callText(server.client, "jobs", { action: "list" })).toBe("no jobs yet");

  const ignored = tempRepo(); // ignored through .git/info/exclude
  onTestFinished(ignored.cleanup);
  const other = await startServer({ cwd: ignored.dir, logins: { "opencode-go": "k" } });
  onTestFinished(other.close);
  expect(await callText(other.client, "jobs", { action: "list" })).toBe("no jobs yet");
});
