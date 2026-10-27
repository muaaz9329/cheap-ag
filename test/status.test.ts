import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, onTestFinished, test } from "vitest";
import { PRESETS } from "../src/routing.js";
import { allowRepo, hermeticHome, serverEntry, tempRepo } from "./harness.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const HOUR = 3_600_000;
const deadPid = spawnSync("true").pid!;

function setup(logins = {}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { home, env } = hermeticHome(logins);
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const status = (cwd = repo.dir) => execFileSync(process.execPath, [serverEntry, "status"], { cwd, env, stdio: "pipe" }).toString();
  const job = (id: string, status: string, hoursAgo: number, pid = deadPid, blockedAt?: string) => {
    const dir = join(repo.dir, ".cheapag", "jobs", id);
    mkdirSync(dir, { recursive: true });
    const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    writeFileSync(join(dir, "result.json"), JSON.stringify({
      format: "cheapag/1", job: id, status, landed: status === "OK", steps: "1", summary: "s", changed: [], risks: [], review: [], missing: [],
      worktree: null, usage: { turns: 3, costUsd: 0.01 }, tests: "pass", selfFix: 0, models: { requested: "m", final: "m", escalated: false },
      pid, timing: { startedAt: at, endedAt: at, blockedAt },
    }));
  };
  const spend = (lines: { hoursAgo: number; model: string; costUsd: number }[]) => {
    mkdirSync(join(home, "state", "cheapag"), { recursive: true });
    writeFileSync(join(home, "state", "cheapag", "spend.jsonl"), lines.map((l) =>
      JSON.stringify({ at: new Date(Date.now() - l.hoursAgo * HOUR).toISOString(), model: l.model, costUsd: l.costUsd }) + "\n").join(""));
  };
  return { repo, env, status, job, spend };
}

test("cheapag status: running jobs, recent results newest first, consent, spend against Go windows", () => {
  const { repo, env, status, job, spend } = setup({ "opencode-go": "dummy-go-key" });
  allowRepo(repo.dir, env, ["--zdr-only"]);
  job("jrun1", "RUNNING", 0.1, process.pid); // this test's pid: alive
  job("jwait", "BLOCKED", 0.5, process.pid, new Date(Date.now() - 25.5 * 60_000).toISOString());
  job("jold1", "FAIL", 5);
  job("jnew1", "OK", 1);
  job("jgone", "BLOCKED", 2); // its server died
  spend([
    { hoursAgo: 1, model: "opencode-go/deepseek-v4.1-flash", costUsd: 4 }, // 5h cap is 20% of $80
    { hoursAgo: 48, model: "opencode-go/deepseek-v4.1-flash", costUsd: 6 },
    { hoursAgo: 24 * 40, model: "opencode-go/qwen3.7-plus", costUsd: 9 }, // outside every window: not shown
  ]);
  const lines = status().trimEnd().split("\n");
  expect(lines[0]).toBe(`cheapag ${version} provider=opencode-go preset=balanced`);
  expect(lines[1]).toMatch(/^consent: zero-retention only \(since \d{4}-\d\d-\d\d\)$/);
  expect(lines.slice(2)).toEqual([
    "running:",
    "  RUNNING jrun1 step=1 turns=3",
    "  BLOCKED jwait step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010 waiting=25m",
    "recent:",
    expect.stringMatching(/^ {2}OK jnew1 step=1 /),
    "  BLOCKED jgone step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010 (its server is gone; cancelled at next start)",
    expect.stringMatching(/^ {2}FAIL jold1 step=1 /),
    "spend (tracked on this machine, all repos; Go windows where capped):",
    "  opencode-go/deepseek-v4.1-flash  5h $4.00/$16.00 (25%)  weekly $10.00/$40.00 (25%)  monthly $10.00/$80.00 (13%)",
  ]);
});

test("cheapag status names the preset: the user's, a repo's cheapag.json over it, custom when none matches", () => {
  const { repo, env, status } = setup({ "opencode-go": "k" });
  const user = join(env.XDG_CONFIG_HOME, "cheapag");
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, "config.json"), JSON.stringify({ models: { implement: "opencode-go/kimi-k3" } }));
  expect(status().split("\n")[0]).toBe(`cheapag ${version} provider=opencode-go preset=custom`);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: PRESETS["opencode-go"].strongest }));
  expect(status().split("\n")[0]).toBe(`cheapag ${version} provider=opencode-go preset=strongest`);
});

test("cheapag status says consent no longer covers the models after a preset change, as the next job would", () => {
  const { repo, env, status } = setup({ "opencode-go": "k" });
  allowRepo(repo.dir, env);
  expect(status().split("\n")[1]).toMatch(/^consent: all models \(since /);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: PRESETS["opencode-go"].strongest }));
  expect(status().split("\n")[1]).toBe("consent: given for other worker models (preset or models changed); run /cheapag:allow");
});

test("cheapag status with no login, no jobs and no spend; outside a repository; bad arguments", () => {
  const { repo, env, status } = setup();
  expect(status()).toBe(`cheapag ${version} provider=none (run npx cheap-agent login)\nconsent: not given; run /cheapag:allow\nrunning: none\nrecent: none\nspend: none tracked in the last 30 days\n`);
  const outside = join(repo.dir, ".git"); // inside .git, rev-parse --show-toplevel fails
  expect(status(outside)).toContain("repo: not a git repository (no jobs or consent here)\nspend: none");
  const r = spawnSync(process.execPath, [serverEntry, "status", "--x"], { cwd: repo.dir, env, encoding: "utf8" });
  expect([r.status, r.stdout]).toEqual([1, "✗ usage: cheapag status\n"]);
});

test("cheapag status shows the prefix of this repo's last Claude Code session, from its transcript", () => {
  const { repo, env } = setup();
  const config = join(repo.dir, ".claude-config"); // a stand-in CLAUDE_CONFIG_DIR
  const projects = join(config, "projects", repo.dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  let id = 0;
  const turn = (read: number, write: number) => JSON.stringify({ type: "assistant", message: { id: `m${id++}`, usage: { input_tokens: 4, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } } } });
  writeFileSync(join(projects, "old.jsonl"), [turn(1, 1)].join("\n"));
  utimesSync(join(projects, "old.jsonl"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const last = turn(40_000, 900);
  writeFileSync(join(projects, "new.jsonl"), [JSON.stringify({ type: "user" }), turn(15_000, 3_396), last, last].join("\n")); // a streamed response repeats its line
  const run = (extra: Record<string, string>) => execFileSync(process.execPath, [serverEntry, "status"], { cwd: repo.dir, env: { ...env, ...extra }, stdio: "pipe" }).toString();
  expect(run({ CLAUDE_CONFIG_DIR: config })).toMatch(/\nclaude prefix: 18\.4k tokens on the first turn of the last session here \(\d{4}-\d\d-\d\d\);.*\nclaude cache: 2 requests, 93% of input from cache, 1h TTL\n/);
  expect(run({ CLAUDE_CONFIG_DIR: join(config, "none") })).not.toContain("claude prefix"); // no transcript: nothing printed
});
