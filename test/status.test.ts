import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, onTestFinished, test, vi } from "vitest";
import { lastSession } from "../src/status.js";
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
  const status = (cwd = repo.dir) =>
    execFileSync(process.execPath, [serverEntry, "status"], { cwd, env, stdio: "pipe" }).toString();
  const job = (id: string, status: string, hoursAgo: number, pid = deadPid, blockedAt?: string) => {
    const dir = join(repo.dir, ".cheapag", "jobs", id);
    mkdirSync(dir, { recursive: true });
    const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        format: "cheapag/1",
        job: id,
        status,
        landed: status === "OK",
        steps: "1",
        summary: "s",
        changed: [],
        risks: [],
        review: [],
        missing: [],
        worktree: null,
        usage: { turns: 3, costUsd: 0.01 },
        tests: "pass",
        selfFix: 0,
        models: { requested: "m", final: "m", escalated: false },
        pid,
        timing: { startedAt: at, endedAt: at, blockedAt },
      }),
    );
  };
  const spend = (lines: { hoursAgo: number; model: string; costUsd: number }[]) => {
    mkdirSync(join(home, "state", "cheapag"), { recursive: true });
    writeFileSync(
      join(home, "state", "cheapag", "spend.jsonl"),
      lines
        .map(
          (l) =>
            JSON.stringify({
              at: new Date(Date.now() - l.hoursAgo * HOUR).toISOString(),
              model: l.model,
              costUsd: l.costUsd,
            }) + "\n",
        )
        .join(""),
    );
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
    expect.stringMatching(/^storage: [\d.]+ KB in \.cheapag \(5 job folders, 0 worktrees\)$/),
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
  writeFileSync(
    join(user, "config.json"),
    JSON.stringify({ models: { implement: "opencode-go/kimi-k3" } }),
  );
  expect(status().split("\n")[0]).toBe(`cheapag ${version} provider=opencode-go preset=custom`);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: PRESETS["opencode-go"].strongest }),
  );
  expect(status().split("\n")[0]).toBe(`cheapag ${version} provider=opencode-go preset=strongest`);
});

test("cheapag status says consent no longer covers the models after a preset change, as the next job would", () => {
  const { repo, env, status } = setup({ openrouter: "k" });
  allowRepo(repo.dir, env);
  expect(status().split("\n")[1]).toMatch(/^consent: all models \(since /);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: PRESETS.openrouter.strongest }),
  );
  expect(status().split("\n")[1]).toBe(
    "consent: given for other worker models (preset or models changed); run /cheapag:allow",
  );
});

test("cheapag status on opencode-go keeps consent valid after a preset change (ticket 45)", () => {
  const { repo, env, status } = setup({ "opencode-go": "k" });
  allowRepo(repo.dir, env);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: PRESETS["opencode-go"].strongest }),
  );
  expect(status().split("\n")[1]).toMatch(/^consent: all models \(since /);
});

test("cheapag status with no login, no jobs and no spend; outside a repository; bad arguments", () => {
  const { repo, env, status } = setup();
  expect(status()).toBe(
    `cheapag ${version} provider=none (run npx cheap-agent login)\nconsent: not given; run /cheapag:allow\nstorage: 0.0 KB in .cheapag (0 job folders, 0 worktrees)\nrunning: none\nrecent: none\nspend: none tracked in the last 30 days\n`,
  );
  const outside = join(repo.dir, ".git"); // inside .git, rev-parse --show-toplevel fails
  expect(status(outside)).toContain(
    "repo: not a git repository (no jobs or consent here)\nspend: none",
  );
  const r = spawnSync(process.execPath, [serverEntry, "status", "--x"], {
    cwd: repo.dir,
    env,
    encoding: "utf8",
  });
  expect([r.status, r.stdout]).toEqual([1, "✗ usage: cheapag status\n"]);
});

test("cheapag status shows the size of .cheapag and points to clean above 1GB", () => {
  const { repo, status } = setup();
  const jobs = join(repo.dir, ".cheapag", "jobs");
  mkdirSync(join(jobs, "jbig1"), { recursive: true });
  writeFileSync(join(jobs, "jbig1", "events.jsonl"), Buffer.alloc(2 * 1024 * 1024));
  expect(status()).toContain("storage: 2.0 MB in .cheapag (1 job folders, 0 worktrees)");
  expect(status()).not.toContain("run: npx cheap-agent clean");

  const trees = join(repo.dir, ".cheapag", "worktrees");
  mkdirSync(join(trees, "jbig1"), { recursive: true });
  const fd = openSync(join(trees, "jbig1", "huge.bin"), "w");
  ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
  closeSync(fd);
  expect(
    status()
      .split("\n")
      .find((line) => line.startsWith("storage: ")),
  ).toMatch(
    /^storage: [\d.]+ GB in \.cheapag \(1 job folders, 1 worktrees\) · run: npx cheap-agent clean$/,
  );
});

test("cheapag status shows the prefix of this repo's last Claude Code session, from its transcript", () => {
  const { repo, env } = setup();
  const config = join(repo.dir, ".claude-config"); // a stand-in CLAUDE_CONFIG_DIR
  const projects = join(config, "projects", repo.dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  let id = 0;
  const turn = (read: number, write: number) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id: `m${id++}`,
        usage: {
          input_tokens: 4,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
          cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
        },
      },
    });
  writeFileSync(join(projects, "old.jsonl"), [turn(1, 1)].join("\n"));
  utimesSync(join(projects, "old.jsonl"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const last = turn(40_000, 900);
  writeFileSync(
    join(projects, "new.jsonl"),
    [JSON.stringify({ type: "user" }), turn(15_000, 3_396), last, last].join("\n"),
  ); // a streamed response repeats its line
  const run = (extra: Record<string, string>) =>
    execFileSync(process.execPath, [serverEntry, "status"], {
      cwd: repo.dir,
      env: { ...env, ...extra },
      stdio: "pipe",
    }).toString();
  expect(run({ CLAUDE_CONFIG_DIR: config })).toMatch(
    /\nclaude prefix: 18\.4k tokens on the first turn of the last session here \(\d{4}-\d\d-\d\d\);.*\nclaude cache: 2 requests, 93% of input from cache, 1h TTL\n/,
  );
  expect(run({ CLAUDE_CONFIG_DIR: join(config, "none") })).not.toContain("claude prefix"); // no transcript: nothing printed
});

// permission bits mean nothing to root or on Windows
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "storage: folders that cannot be read or entered are skipped, never an error",
  () => {
    const { repo, status, job } = setup();
    job("jgood", "OK", 1);
    const locked = join(repo.dir, ".cheapag", "jobs", "jgood", "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "big.bin"), "x".repeat(50_000));
    const trees = join(repo.dir, ".cheapag", "worktrees");
    mkdirSync(join(trees, "jtree"), { recursive: true });
    chmodSync(locked, 0o000); // cannot be listed
    chmodSync(trees, 0o444); // can be listed, but its entries cannot be examined
    onTestFinished(() => {
      chmodSync(locked, 0o755);
      chmodSync(trees, 0o755);
    });
    // the locked folder's 50 KB are not counted, and the worktree is not seen as a folder
    expect(status()).toMatch(/\nstorage: 0\.\d KB in \.cheapag \(1 job folders, 0 worktrees\)\n/);
  },
);

test("lastSession: undefined for a half-written transcript, and for one with no usage yet", () => {
  const config = mkdtempSync(join(tmpdir(), "cheapag-claude-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(config, { recursive: true, force: true });
  });
  const root = "/some/repo";
  const dir = join(config, "projects", "-some-repo");
  mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 };
  writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ message: { id: "m1", usage } }) + "\n");
  expect(lastSession(root)).toMatchObject({ prefix: 40, requests: 1, hitRate: 0.75 });
  writeFileSync(
    join(dir, "a.jsonl"),
    JSON.stringify({ message: { id: "m1", usage } }) + "\n{ half-written",
  );
  expect(lastSession(root)).toBeUndefined();
  writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ message: { id: "m1" } }) + "\n");
  expect(lastSession(root)).toBeUndefined();
});

/** Runs `cheapag status` and returns what a user sees: exit code, stdout and stderr. */
function runStatus(cwd: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [serverEntry, "status"], { cwd, env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The storage size depends on file sizes the test does not control; the rest of the line is pinned. */
const anySize = (stdout: string) => stdout.replace(/^storage: [\d.]+ KB/m, "storage: <size> KB");

function writeConsentFile(dir: string, consent: Record<string, unknown>) {
  mkdirSync(join(dir, ".cheapag"), { recursive: true });
  writeFileSync(join(dir, ".cheapag", "consent.json"), JSON.stringify(consent));
}

test("cheapag status pins the whole screen: another provider's consent, older jobs past five, a session, a foreign model, uncapped and redacted spend", () => {
  const { repo, env, job, spend } = setup({ "opencode-go": "k" });
  writeConsentFile(repo.dir, {
    mode: "all",
    provider: "openrouter",
    approvedAt: "2026-01-02T03:04:05.000Z",
  });
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { research: "openrouter/acme/coder" } }),
  );
  for (let n = 1; n <= 7; n++) job(`j${n}`, "OK", n);
  const config = join(repo.dir, ".claude-config");
  const projects = join(config, "projects", repo.dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const transcript = join(projects, "s.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ message: { id: "m1", usage: { input_tokens: 1500 } } }),
  );
  const sessionTime = new Date("2026-01-02T12:00:00Z");
  utimesSync(transcript, sessionTime, sessionTime);
  spend([
    { hoursAgo: 1, model: "openrouter/sk-abcdefghijklmnop1234", costUsd: 1.5 },
    { hoursAgo: 100, model: "openrouter/acme/coder", costUsd: 2 },
  ]);
  const r = runStatus(repo.dir, { ...env, CLAUDE_CONFIG_DIR: config });
  expect([r.code, r.stderr]).toEqual([0, ""]);
  expect(anySize(r.stdout)).toBe(
    [
      `cheapag ${version} provider=opencode-go preset=balanced`,
      "consent: given for OpenRouter, not the current provider; run /cheapag:allow",
      "storage: <size> KB in .cheapag (7 job folders, 0 worktrees)",
      "running: none",
      "recent:",
      "  OK j1 step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010",
      "  OK j2 step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010",
      "  OK j3 step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010",
      "  OK j4 step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010",
      "  OK j5 step=1 files=0 +0/-0 tests=pass turns=3 cost=$0.010",
      "  … +2 older (jobs list)",
      'claude prefix: 1.5k tokens on the first turn of the last session here (2026-01-02); see "What it costs to keep in context" in the plugin README',
      "claude cache: 1 requests, 0% of input from cache",
      "! models.research names openrouter/acme/coder, which is not a model on OpenCode Go; it is ignored and the worker runs opencode-go/deepseek-v4.1-flash. Fix it in cheapag.json or run npx cheap-agent model",
      "spend (tracked on this machine, all repos; Go windows where capped):",
      "  openrouter/acme/coder  5h $0.00  weekly $2.00  monthly $2.00",
      "  openrouter/[redacted]  5h $1.50  weekly $1.50  monthly $1.50",
      "",
    ].join("\n"),
  );
});

test("cheapag status with only live jobs: running lists them and recent is none", () => {
  const { repo, env, job } = setup();
  job("jrun1", "RUNNING", 0.1, process.pid);
  const r = runStatus(repo.dir, env);
  expect([r.code, r.stderr]).toEqual([0, ""]);
  expect(anySize(r.stdout)).toBe(
    [
      `cheapag ${version} provider=none (run npx cheap-agent login)`,
      "consent: not given; run /cheapag:allow",
      "storage: <size> KB in .cheapag (1 job folders, 0 worktrees)",
      "running:",
      "  RUNNING jrun1 step=1 turns=3",
      "recent: none",
      "spend: none tracked in the last 30 days",
      "",
    ].join("\n"),
  );
});

test("a hand-edited consent without approvedAt crashes status for the current provider, but not for another one", () => {
  const { repo, env } = setup({ "opencode-go": "k" });
  writeConsentFile(repo.dir, { mode: "all", provider: "opencode-go" });
  const crashed = runStatus(repo.dir, env);
  expect([crashed.code, crashed.stdout]).toEqual([
    1,
    `cheapag ${version} provider=opencode-go preset=balanced\n`,
  ]);
  expect(crashed.stderr).toContain(
    "TypeError: Cannot read properties of undefined (reading 'slice')",
  );

  writeConsentFile(repo.dir, { mode: "all", provider: "openrouter" });
  const other = runStatus(repo.dir, env);
  expect([other.code, other.stderr]).toEqual([0, ""]);
  expect(other.stdout.split("\n")[1]).toBe(
    "consent: given for OpenRouter, not the current provider; run /cheapag:allow",
  );
});

test("cheapag status outside a repository: the whole screen, and model warnings from the config there", () => {
  const { repo, status } = setup();
  const outside = join(repo.dir, ".git"); // inside .git, rev-parse --show-toplevel fails
  expect(status(outside)).toBe(
    `cheapag ${version} provider=none (run npx cheap-agent login)\nrepo: not a git repository (no jobs or consent here)\nspend: none tracked in the last 30 days\n`,
  );

  // without a repo root the warnings read cheapag.json in the current directory
  const loggedIn = setup({ "opencode-go": "k" });
  const gitDir = join(loggedIn.repo.dir, ".git");
  writeFileSync(
    join(gitDir, "cheapag.json"),
    JSON.stringify({ models: { research: "openrouter/acme/coder" } }),
  );
  const r = runStatus(gitDir, loggedIn.env);
  expect([r.code, r.stderr]).toEqual([0, ""]);
  expect(r.stdout).toBe(
    [
      `cheapag ${version} provider=opencode-go preset=balanced`,
      "repo: not a git repository (no jobs or consent here)",
      "! models.research names openrouter/acme/coder, which is not a model on OpenCode Go; it is ignored and the worker runs opencode-go/deepseek-v4.1-flash. Fix it in cheapag.json or run npx cheap-agent model",
      "spend: none tracked in the last 30 days",
      "",
    ].join("\n"),
  );
});

test("storage: sizes round at the KB, MB and GB edges, and exactly 1GB does not ask for clean", () => {
  const { repo, status } = setup();
  const folder = join(repo.dir, ".cheapag", "worktrees", "jtree");
  mkdirSync(folder, { recursive: true });
  const sized = (bytes: number) => {
    const fd = openSync(join(folder, "data.bin"), "w");
    ftruncateSync(fd, bytes);
    closeSync(fd);
    return status()
      .split("\n")
      .find((line) => line.startsWith("storage: "));
  };
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  expect(sized(MB - 1)).toBe("storage: 1024.0 KB in .cheapag (0 job folders, 1 worktrees)");
  expect(sized(MB)).toBe("storage: 1.0 MB in .cheapag (0 job folders, 1 worktrees)");
  expect(sized(GB - 1)).toBe("storage: 1024.0 MB in .cheapag (0 job folders, 1 worktrees)");
  expect(sized(GB)).toBe("storage: 1.0 GB in .cheapag (0 job folders, 1 worktrees)");
  expect(sized(GB + 1)).toBe(
    "storage: 1.0 GB in .cheapag (0 job folders, 1 worktrees) · run: npx cheap-agent clean",
  );
});

// creating symlinks needs extra rights on Windows
test.skipIf(process.platform === "win32")(
  "storage: loose files count but are not folders, and symlinks are neither counted nor followed",
  () => {
    const { repo, status } = setup();
    const jobs = join(repo.dir, ".cheapag", "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "loose.txt"), Buffer.alloc(2048));
    const elsewhere = join(repo.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
    symlinkSync(elsewhere, join(jobs, "jlinked"));
    symlinkSync(join(elsewhere, "big.bin"), join(jobs, "big-link.bin"));
    expect(status()).toContain("\nstorage: 2.0 KB in .cheapag (0 job folders, 0 worktrees)\n");
  },
);

test("lastSession: the newest transcript, every TTL, messages without an id, and no input at all", () => {
  const config = mkdtempSync(join(tmpdir(), "cheapag-claude-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(config, { recursive: true, force: true });
  });
  const root = "/some/repo";
  expect(lastSession(root)).toBeUndefined(); // no projects folder for this repo
  const dir = join(config, "projects", "-some-repo");
  mkdirSync(dir, { recursive: true });
  expect(lastSession(root)).toBeUndefined(); // a folder with no transcript
  writeFileSync(join(dir, "notes.txt"), "not a transcript");
  expect(lastSession(root)).toBeUndefined();

  const old = join(dir, "old.jsonl");
  writeFileSync(old, JSON.stringify({ message: { id: "o", usage: { input_tokens: 999 } } }));
  utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const file = join(dir, "new.jsonl");
  const write = (...usages: object[]) => {
    writeFileSync(file, usages.map((usage) => JSON.stringify({ message: { usage } })).join("\n"));
    return statSync(file).mtime.toISOString();
  };
  const cache = (m5: number, h1: number) => ({
    input_tokens: 1,
    cache_read_input_tokens: 3,
    cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 },
  });

  let at = write(cache(0, 0), cache(0, 0)); // no id: each line is its own response
  expect(lastSession(root)).toStrictEqual({
    prefix: 4,
    at,
    requests: 2,
    hitRate: 0.75,
    ttl: undefined,
  });
  at = write(cache(5, 0));
  expect(lastSession(root)).toStrictEqual({ prefix: 4, at, requests: 1, hitRate: 0.75, ttl: "5m" });
  at = write(cache(0, 7));
  expect(lastSession(root)).toStrictEqual({ prefix: 4, at, requests: 1, hitRate: 0.75, ttl: "1h" });
  at = write(cache(5, 0), cache(0, 7));
  expect(lastSession(root)).toStrictEqual({
    prefix: 4,
    at,
    requests: 2,
    hitRate: 0.75,
    ttl: "5m+1h",
  });
  at = write({});
  expect(lastSession(root)).toStrictEqual({
    prefix: 0,
    at,
    requests: 1,
    hitRate: 0,
    ttl: undefined,
  });
});

test("lastSession reads ~/.claude when CLAUDE_CONFIG_DIR is not set", () => {
  const home = mkdtempSync(join(tmpdir(), "cheapag-home-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("HOME", home);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const dir = join(home, ".claude", "projects", "-some-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ message: { usage: { input_tokens: 2 } } }));
  expect(lastSession("/some/repo")).toMatchObject({ prefix: 2, requests: 1 });
});
