import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, startServer, tempRepo } from "./harness.js";
import { isAlive } from "../src/platform.js";

const plan = (doneWhen: string) => `# Hello\n\n## 1 hello two\nfiles: src/hello.ts, README.md\ndo: export hello = 2\ndone-when: ${doneWhen}\n`;
/** Passes once src/hello.ts exports 2. */
const CHECK = `import { readFileSync } from "node:fs";
if (readFileSync("src/hello.ts", "utf8").trim() !== "export const hello = 2;") { console.log(" ✗ hello › equals 2"); process.exit(1); }
`;
/** A verify command that never ends on its own; its child's pid goes to `pidFile`, to prove the group is killed. */
const SLOW = (pidFile: string) => `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => {}, 60_000);
`;
const LONG: Action = { wait: 60_000 }; // a model step that only an abort ends

/** A repo with the plan and config files written, a fake worker scripted per prompt, and a server on both. */
async function scenario(opts: { scripts: Action[][]; doneWhen?: string; repoConfig?: unknown; userConfig?: unknown }) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "p.md"), plan(opts.doneWhen ?? "hello is 2"));
  writeFileSync(join(repo.dir, "check.mjs"), CHECK);
  const pidFile = join(repo.dir, ".git", "slow.pid");
  writeFileSync(join(repo.dir, "slow.mjs"), SLOW(pidFile));
  if (opts.repoConfig) writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(opts.repoConfig));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  for (const s of opts.scripts) fake.script(...s);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  if (opts.userConfig) {
    mkdirSync(join(server.home, "config", "cheapag"), { recursive: true });
    writeFileSync(join(server.home, "config", "cheapag", "config.json"), JSON.stringify(opts.userConfig));
  }
  const delegate = () => callText(server.client, "delegate", { plan: ".plan/p.md", steps: "1" });
  const jobs = (action: string, job?: string) => callText(server.client, "jobs", { action, ...(job && { job }) });
  const record = (job: string) => JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  return { repo, fake, server, delegate, jobs, record, pidFile };
}

const jobOf = (text: string) => text.match(/^\w+ (j[0-9a-z]{4}) /)![1];

test("turn cap during a self-fix: aborted, last check passes → PARTIAL with missing: from the finish report (repo config)", async () => {
  const { repo, fake, delegate, record } = await scenario({
    doneWhen: "`node check.mjs` passes",
    repoConfig: { limits: { max_turns: 3 } },
    scripts: [
      [{ edit: "src/hello.ts", content: "export const hello = 1;\n" }, { tool: "write" }, { finish: { summary: "hello added", risks: [], review: [], missing: ["README note not written"] } }],
      [{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, LONG, { finish: { summary: "never", risks: [], review: [], missing: [] } }],
    ],
  });
  const text = await delegate();
  const job = jobOf(text);
  expect(text).toBe([
    `PARTIAL ${job} step=1 files=1 +1/-0 tests=pass turns=3 cost=$0.000 fix=1`,
    "summary: hello added",
    "changed:",
    "  A src/hello.ts +1",
    "missing:",
    "  - README note not written",
    `worktree: .cheapag/worktrees/${job}/`,
    `log: .cheapag/jobs/${job}/`,
  ].join("\n"));
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false); // never lands
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job, "src/hello.ts"))).toBe(true);
  expect(record(job)).toMatchObject({ status: "PARTIAL", landed: false, missing: ["README note not written"], verify: [{ ok: false }, { ok: true }] });
});

test("turn cap with nothing changed → FAIL with the reason; no hand-over (user config, merged key by key with the repo's)", async () => {
  const { repo, fake, delegate } = await scenario({
    userConfig: { limits: { max_turns: 2, max_cost_usd: 0.001 } },
    repoConfig: { limits: { max_cost_usd: 5 } }, // the repo raises the cost cap; the user's turn cap still applies
    scripts: [[{ tool: "read" }, { usage: { cost: 0.002 } }, { tool: "grep" }, LONG, { tool: "write" }]],
  });
  const text = await delegate();
  const job = jobOf(text);
  expect(text.split("\n")[0]).toMatch(new RegExp(`^FAIL ${job} step=1 files=0 \\+0/-0 tests=none turns=\\d+ `));
  expect(text.split("\n")[0]).not.toContain("esc=1");
  expect(text).toContain("\nreason: turn cap (2) reached\n");
  expect(text).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(fake.recorded.aborts).toHaveLength(1);
  // ticket 28: no hand-over on the escalation model; ticket 29: one findings prompt on the same model (unanswered here, so no found:)
  expect(fake.recorded.prompts).toHaveLength(2);
  expect(fake.recorded.prompts[1]).toMatchObject({ model: undefined, parts: [{ type: "text", text: expect.stringMatching(/^You were stopped before finishing\. Without calling any tool/) }] });
  expect(text).not.toContain("\nfound:");
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
});

test("fail fast: a step with checks and no test file by repro_by_turns → FAIL at once, so Claude takes over early", async () => {
  const { fake, delegate } = await scenario({
    doneWhen: "`node check.mjs` passes",
    repoConfig: { limits: { repro_by_turns: 2, max_turns: 10 } },
    scripts: [[{ tool: "read" }, { tool: "grep" }, { tool: "read" }, LONG, { tool: "write" }]],
  });
  const text = await delegate();
  const job = jobOf(text);
  expect(text.split("\n")[0]).toMatch(new RegExp(`^FAIL ${job} step=1 files=0 `));
  expect(text).toContain("\nreason: no reproduction test by turn 2; the worker was still exploring\n");
  expect(fake.recorded.aborts).toHaveLength(1);
});

test("a stopped job asks the worker for its findings once; the FAIL block carries them as found:, leading when the worker gave no summary", async () => {
  const { fake, delegate } = await scenario({
    doneWhen: "`node check.mjs` passes",
    repoConfig: { limits: { repro_by_turns: 2, max_turns: 10 } },
    scripts: [
      [{ tool: "read" }, { tool: "grep" }, { tool: "read" }, LONG, { tool: "write" }],
      [{ text: "Bug in src/hello.ts:hello, it returns 1.\nRuled out the config loader." }],
    ],
  });
  const text = await delegate();
  expect(text).toContain("\nfound: Bug in src/hello.ts:hello, it returns 1. Ruled out the config loader.\n");
  expect(text).toContain("\nreason: no reproduction test by turn 2;");
  expect(fake.recorded.prompts).toHaveLength(2);
});

test("fail fast does not fire once a test file exists; the OK headline names it as test=", async () => {
  const { delegate } = await scenario({
    doneWhen: "`node check.mjs` passes",
    repoConfig: { limits: { repro_by_turns: 2, max_turns: 10 } },
    scripts: [[
      { edit: "test/hello.test.mjs", content: "process.exit(0);\n" }, { tool: "write" }, { tool: "read" }, { tool: "grep" },
      { edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" },
      { finish: { summary: "fixed", risks: [], review: [], missing: [], repro: "n/a" } as never },
    ]],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} step=1 files=2 .* test=test\/hello\.test\.mjs$/);
});

test("minute cap → session aborted → TIMEOUT with reason; nothing lands, worktree kept", async () => {
  const { repo, fake, delegate } = await scenario({
    repoConfig: { limits: { max_minutes: 0.01 } },
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, LONG, { finish: { summary: "never", risks: [], review: [], missing: [] } }]],
  });
  const started = Date.now();
  const text = await delegate();
  const job = jobOf(text);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(text.split("\n")[0]).toMatch(new RegExp(`^TIMEOUT ${job} step=1 files=1 \\+1/-0 tests=none turns=1 `));
  expect(text).toContain("\nreason: minute cap (0.01 min) reached\n");
  expect(text).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(fake.recorded.aborts).toEqual([fake.recorded.sessions[0].id]);
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
});

test("minute cap during verify kills the verify process group → TIMEOUT", async () => {
  const { repo, delegate, pidFile } = await scenario({
    doneWhen: "`node slow.mjs` finishes",
    repoConfig: { limits: { max_minutes: 0.03 } },
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, { finish: { summary: "done", risks: [], review: [], missing: [] } }]],
  });
  const text = await delegate();
  expect(text).toMatch(/^TIMEOUT /);
  expect(text).toContain("\nreason: minute cap (0.03 min) reached\n");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
});

test("cost cap → session aborted → BUDGET reason: job cap", async () => {
  const { repo, fake, delegate } = await scenario({
    repoConfig: { limits: { max_cost_usd: 0.01 } },
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, { usage: { cost: 0.006 } }, { usage: { cost: 0.006 } }, LONG]],
  });
  const text = await delegate();
  const job = jobOf(text);
  expect(text.split("\n")[0]).toBe(`BUDGET ${job} step=1 files=1 +1/-0 tests=none turns=1 cost=$0.012`);
  expect(text).toContain("\nreason: job cap ($0.01) reached\n");
  expect(text).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
});

test("jobs list/show while a job runs, then cancel aborts it → CANCELLED, worktree kept; the delegate call gets the same block", async () => {
  const { repo, fake, delegate, jobs, record } = await scenario({
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, LONG, { finish: { summary: "never", risks: [], review: [], missing: [] } }]],
  });
  expect(await jobs("list")).toBe("no jobs yet");
  // MCP requests are handled concurrently: the delegate call stays pending while jobs calls are answered
  const pending = delegate();
  let listed = "";
  await vi.waitFor(async () => expect((listed = await jobs("list"))).toMatch(/^RUNNING j[0-9a-z]{4} step=1 turns=\d+$/));
  const job = listed.split(" ")[1];
  expect(await jobs("show", job)).toMatch(new RegExp(`^RUNNING ${job} step=1 turns=\\d+$`));
  await vi.waitFor(() => expect(fake.recorded.prompts).toHaveLength(1));
  expect(record(job)).toMatchObject({ status: "RUNNING", pid: expect.any(Number), worktree: `.cheapag/worktrees/${job}` });

  const cancelled = await jobs("cancel", job);
  expect(cancelled.split("\n")[0]).toBe(`CANCELLED ${job} step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000`);
  expect(cancelled).toContain("\nreason: cancelled on request\n");
  expect(cancelled).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(await pending).toBe(cancelled);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job, "src/hello.ts"))).toBe(true);

  expect(await jobs("list")).toBe(cancelled.split("\n")[0]);
  // show repeats the block from disk: log path, never log contents
  expect(await jobs("show", job)).toBe(cancelled);
  expect(await jobs("cancel", job)).toBe(`FAIL reason: job ${job} already finished (CANCELLED); nothing to cancel`);
  expect(await jobs("show", "jzzzz")).toBe("FAIL reason: job jzzzz not found");
  expect(await jobs("show", "../x")).toBe("FAIL reason: jobs show needs a job id, e.g. j7f3a");
  expect(await jobs("cancel")).toBe("FAIL reason: jobs cancel needs a job id, e.g. j7f3a");
});

test("cancel during verify kills the verify process group", async () => {
  const { fake, delegate, jobs, pidFile } = await scenario({
    doneWhen: "`node slow.mjs` finishes",
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, { finish: { summary: "done", risks: [], review: [], missing: [] } }]],
  });
  const pending = delegate();
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
  const pid = Number(readFileSync(pidFile, "utf8"));
  const job = (await jobs("list")).split(" ")[1];
  const cancelled = await jobs("cancel", job);
  expect(cancelled).toMatch(new RegExp(`^CANCELLED ${job} `));
  expect(await pending).toBe(cancelled);
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  expect(fake.recorded.prompts).toHaveLength(1); // no self-fix after a cancel
});

test("server restart: a job left RUNNING by a dead server becomes CANCELLED (server restart); a live server's job is left alone", async () => {
  const { repo, fake, server, delegate, record } = await scenario({
    scripts: [[{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, LONG]],
  });
  void delegate().catch(() => {}); // the server dies under it
  await vi.waitFor(() => expect(fake.recorded.prompts).toHaveLength(1));
  const job = (await callText(server.client, "jobs", { action: "list" })).split(" ")[1];
  await vi.waitFor(() => expect(record(job).sessionID).toBeTruthy());
  process.kill(server.pid, "SIGKILL");
  await vi.waitFor(() => expect(isAlive(server.pid)).toBe(false));

  // a copy owned by a live process (this test runner), and a BLOCKED one whose process is gone
  const alive = "jaliv", blocked = "jblkd";
  for (const [id, patch] of [[alive, { pid: process.pid }], [blocked, { status: "BLOCKED" }]] as const) {
    mkdirSync(join(repo.dir, ".cheapag", "jobs", id));
    writeFileSync(join(repo.dir, ".cheapag", "jobs", id, "result.json"), JSON.stringify({ ...record(job), job: id, ...patch }));
  }

  const next = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(next.close);
  const shown = await callText(next.client, "jobs", { action: "show", job });
  expect(shown.split("\n")[0]).toMatch(new RegExp(`^CANCELLED ${job} step=1 `));
  expect(shown).toContain("\nreason: server restart\n");
  expect(shown).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(record(job)).toMatchObject({ status: "CANCELLED", reason: "server restart", landed: false });
  expect(record(blocked)).toMatchObject({ status: "CANCELLED", reason: "server restart" });
  expect(record(alive)).toMatchObject({ status: "RUNNING" });
  expect(await callText(next.client, "jobs", { action: "cancel", job: alive })).toBe(
    `FAIL reason: job ${alive} is RUNNING but not in this session (server pid ${process.pid}); cancel it from the session that started it`,
  );
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
});

test.each([
  [{ limits: { max_turns: 0 } }, "limits.max_turns must be a positive whole number"],
  [{ limits: { max_turns: 2.5 } }, "limits.max_turns must be a positive whole number"],
  [{ limits: { max_minutes: "20" } }, "limits.max_minutes must be a positive number"],
  [{ limits: { max_parallel: 1.5 } }, "limits.max_parallel must be a positive whole number"],
  [{ limits: { repro_by_turns: 0 } }, "limits.repro_by_turns must be a positive whole number"],
  [{ limits: { takeover_calls: -1 } }, "limits.takeover_calls must be a non-negative whole number"],
  [{ limits: { takeover_calls: 2.5 } }, "limits.takeover_calls must be a non-negative whole number"],
  [{ takeover: "opus" }, "takeover must be one of sonnet, self"],
  [{ limits: [] }, "limits must be an object"],
  [{ integration_cmd: " " }, "integration_cmd must be a non-empty string"],
])("a bad config %j fails before any job", async (config, message) => {
  const { repo, fake, delegate } = await scenario({ repoConfig: config, scripts: [] });
  expect(await delegate()).toBe(`FAIL reason: ${join(repo.dir, "cheapag.json")}: ${message}`);
  expect(fake.recorded.sessions).toEqual([]);
});

test("ticket 33: a medium step gets twice an easy one's turns before the turn cap", async () => {
  const repoConfig = { limits: { max_turns: 2 } };
  const easy = await scenario({ repoConfig, scripts: [[{ tool: "read" }, { tool: "grep" }, LONG, { tool: "write" }]] });
  const easyText = await callText(easy.server.client, "delegate", { plan: ".plan/p.md", steps: "1", difficulty: "easy" });
  expect(easyText.split("\n")[0]).toMatch(/^FAIL \w+ step=1 files=0 \+0\/-0 tests=none turns=2 /);
  expect(easyText).toContain("\nreason: turn cap (2) reached\n");

  const medium = await scenario({ repoConfig, scripts: [[{ tool: "read" }, { tool: "grep" }, { tool: "read" }, { tool: "grep" }, LONG, { tool: "write" }]] });
  const mediumText = await callText(medium.server.client, "delegate", { plan: ".plan/p.md", steps: "1", difficulty: "medium" });
  expect(mediumText.split("\n")[0]).toMatch(/^FAIL \w+ step=1 files=0 \+0\/-0 tests=none turns=4 /);
  expect(mediumText).toContain("\nreason: turn cap (4) reached\n");
});

test("ticket 33: a turn cap during the fixes still escalates once, on its own budget; esc fixes it and the job lands", async () => {
  const { repo, fake, server, record } = await scenario({
    doneWhen: "`node check.mjs` passes",
    repoConfig: { limits: { max_turns: 3, repro_by_turns: 20 } },
    scripts: [
      // a failing change, then enough tools to hit the turn cap (3)
      [{ edit: "src/hello.ts", content: "export const hello = 1;\n" }, { tool: "write" }, { tool: "read" }, { tool: "grep" }, LONG, { tool: "write" }],
      // the escalation model's own, smaller budget runs and fixes the check
      [{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, { finish: { summary: "esc fixed it", risks: [], review: [], missing: [] } }],
    ],
  });
  const text = await callText(server.client, "delegate", { plan: ".plan/p.md", steps: "1" });
  const job = jobOf(text);
  expect(text.split("\n")[0]).toBe(`OK ${job} step=1 files=1 +1/-0 tests=pass turns=5 cost=$0.000 esc=1 model=opencode-go/deepseek-v4-pro`);
  expect(fake.recorded.prompts.some((p) => p.model?.modelID === "deepseek-v4-pro")).toBe(true);
  expect(record(job)).toMatchObject({ status: "OK", landed: true, models: { escalated: true, final: "opencode-go/deepseek-v4-pro" } });
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
});

test("an absolute repo path typed in a task reaches the worker as the worktree path", async () => {
  const { repo, fake, server } = await scenario({ scripts: [[{ finish: { summary: "ok", risks: [], review: [], missing: [] } }]] });
  const text = await callText(server.client, "delegate", { task: `read ${repo.dir}/src/a.ts and report` });
  const job = jobOf(text);
  const prompt = (fake.recorded.prompts[0].parts[0] as { text: string }).text;
  expect(prompt).toContain(`${join(repo.dir, ".cheapag", "worktrees", job)}/src/a.ts`);
  expect(prompt.split(repo.dir).length - 1).toBe(prompt.split(join(repo.dir, ".cheapag", "worktrees", job)).length - 1); // every repo.dir is the worktree's prefix
});
