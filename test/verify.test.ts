import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";
import {
  errorTail,
  checkAllows,
  envFailure,
  runVerify,
  sameFailure,
  verifyCommands,
} from "../src/verify.js";

/** A committed check script that prints test-runner-style output: passes, noise, duplicates and frames. */
const CHECK = `import { readFileSync } from "node:fs";
const v = readFileSync("src/hello.ts", "utf8").trim();
if (v === "export const hello = 2;") { console.log(" ✓ hello › equals 2"); process.exit(0); }
console.log(" ✓ unrelated › still passes");
console.log(" ✗ hello › equals 2");
console.log('   expected "export const hello = 2;", received ' + JSON.stringify(v));
console.log("    at node:internal/modules/run_main:1:1");
console.log("    at check.mjs:5:3");
for (const n of [1, 2, 3]) console.log(\` ✗ item \${n} not ready\`);
console.log(" ✗ other › a");
console.log(" ✗ other › b");
process.exit(1);
`;

/** Fails with a message that contains "passed" and a frame printed as an absolute path inside the worktree. */
const FAIL_ABS = `console.log("TypeError: 3 arguments passed, expected 2");
console.log("    at " + process.cwd() + "/src/hello.ts:4:1");
process.exit(1);
`;

const plan = (doneWhen: string) =>
  `# Hello\n\n## 1 hello two\nfiles: src/hello.ts\ndo: export hello = 2\ndone-when: ${doneWhen}\n`;
const WRONG = (summary: string): Action[] => [
  { edit: "src/hello.ts", content: "export const hello = 1;\n" },
  { tool: "write" },
  { usage: { cost: 0.001 } },
  { finish: { summary, risks: [], review: ["src/hello.ts:1-1"], missing: [] } },
];
const RIGHT = (summary: string): Action[] => [
  { edit: "src/hello.ts", content: "export const hello = 2;\n" },
  { tool: "write" },
  { usage: { cost: 0.001 } },
  { finish: { summary, risks: [], review: ["src/hello.ts:1-1"], missing: [] } },
];

async function scenario(
  scripts: Action[][],
  doneWhen = "`node check.mjs` passes",
  files: Record<string, string> = {},
) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "check.mjs"), CHECK);
  writeFileSync(join(repo.dir, "fail-abs.mjs"), FAIL_ABS);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "hello.ts"), "export const hello = 0;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "check");
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "p.md"), plan(doneWhen));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  for (const s of scripts) fake.script(...s);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: [],
  });
  onTestFinished(server.close);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(
      join(path.startsWith("~/") ? server.home : repo.dir, path.replace(/^~\//, ""), ".."),
      { recursive: true },
    );
    writeFileSync(
      join(path.startsWith("~/") ? server.home : repo.dir, path.replace(/^~\//, "")),
      content,
    );
  }
  const result = await server.client.callTool({
    name: "delegate",
    arguments: { plan: ".plan/p.md", steps: "1" },
  });
  const text = (result.content as { text: string }[])[0].text;
  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)?.[1] ?? "(no job)"; // pre-job FAILs carry no id
  const record =
    job === "(no job)"
      ? undefined
      : JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  const prompts = fake.recorded.prompts.map((p) => ({
    ...p,
    text: (p.parts[0] as { text: string }).text,
  }));
  return { repo, fake, text, job, record, prompts };
}

test("verify passes first time: OK, tests=pass, landed, no fix", async () => {
  const { repo, text, record } = await scenario([RIGHT("set hello to 2")]);
  expect(text.split("\n")[0]).toMatch(
    /^OK j[0-9a-z]{4} step=1 files=1 \+1\/-1 tests=pass turns=2 cost=\$0\.001$/,
  );
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  expect(record).toMatchObject({
    status: "OK",
    landed: true,
    selfFix: 0,
    verify: [{ cmd: "node check.mjs", ok: true }],
    tried: [],
  });
});

test("verify passes after a self-fix in the same session: OK fix=1, landed", async () => {
  const { repo, fake, text, record, prompts } = await scenario([
    WRONG("set hello to 1"),
    RIGHT("corrected hello to 2"),
  ]);
  expect(text.split("\n")[0]).toMatch(
    /^OK j[0-9a-z]{4} step=1 files=1 \+1\/-1 tests=pass turns=4 cost=\$0\.002 fix=1$/,
  );
  expect(text).toContain("\nsummary: corrected hello to 2\n");
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  // the fix went to the same session, on the same model, with the error tail
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(prompts.map((p) => p.sessionID)).toEqual([
    fake.recorded.sessions[0].id,
    fake.recorded.sessions[0].id,
  ]);
  expect(prompts[1].model).toBeUndefined();
  expect(prompts[1].text).toMatch(
    /^Verification failed\. Fix the cause, then call finish again\.\n\n`node check\.mjs`\n  ✗ hello › equals 2\n/,
  );
  expect(record).toMatchObject({
    selfFix: 1,
    tried: ["fix 1: corrected hello to 2 → passed"],
    verify: [{ ok: false }, { ok: true }],
  });
});

test("still failing after 2 self-fixes and the escalation: FAIL with error, tried, review and worktree; nothing lands", async () => {
  const { repo, text, job, record, prompts } = await scenario([
    WRONG("first try"),
    WRONG("second try"),
    WRONG("third try"),
    WRONG("stronger try"),
  ]);
  expect(text).toBe(
    [
      `FAIL ${job} step=1 files=1 +1/-1 tests=fail turns=8 cost=$0.004 fix=2 esc=1 model=opencode-go/deepseek-v4-pro`,
      "summary: stronger try",
      "changed:",
      "  M src/hello.ts +1 -1",
      "review: src/hello.ts:1-1",
      "error: `node check.mjs`",
      "  ✗ hello › equals 2",
      '    expected "export const hello = 2;", received "export const hello = 1;"',
      "    at check.mjs:5:3",
      "  ✗ item 1 not ready (×3)",
      "  ✗ other › a",
      "tried:",
      "  - fix 1: second try → same failure",
      "  - fix 2: third try → same failure",
      "  - esc: stronger try → same failure",
      `worktree: .cheapag/worktrees/${job}/`,
      `log: .cheapag/jobs/${job}/`,
    ].join("\n"),
  );
  // the escalation was the same session on the escalation model
  expect(prompts.map((p) => p.model)).toEqual([
    undefined,
    undefined,
    undefined,
    { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
  ]);
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 0;\n");
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(record).toMatchObject({
    status: "FAIL",
    landed: false,
    selfFix: 2,
    tests: "fail",
    models: {
      requested: "opencode-go/deepseek-v4.1-flash",
      final: "opencode-go/deepseek-v4-pro",
      escalated: true,
    },
  });
  expect(record.verify).toHaveLength(4);
});

test("a worker error during a self-fix is a FAIL with its reason; nothing lands", async () => {
  const { repo, text } = await scenario([
    WRONG("first try"),
    [{ error: { name: "APIError", message: "upstream 500" } }],
  ]);
  expect(text.split("\n")[0]).toMatch(/^FAIL .* tests=fail .* fix=1$/);
  expect(text).toContain("\ntried:\n  - fix 1: (no summary) → worker error\n");
  expect(text).toContain("\nreason: worker error: upstream 500\n");
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 0;\n");
});

test("a worker error before verification reports tests=none, not fail", async () => {
  const { text, record } = await scenario([
    [{ error: { name: "APIError", message: "upstream 500" } }],
  ]);
  expect(text.split("\n")[0]).toContain(" tests=none ");
  expect(record.verify).toEqual([]);
});

test("the error tail keeps a failure line that mentions 'passed' and makes worktree paths repo-relative; verify.log has it all", async () => {
  const { repo, job, text } = await scenario(
    [WRONG("a"), WRONG("b"), WRONG("c"), WRONG("d")],
    "`node fail-abs.mjs` succeeds",
  );
  expect(text).toContain(
    "\nerror: `node fail-abs.mjs`\n  TypeError: 3 arguments passed, expected 2\n    at src/hello.ts:4:1\n",
  );
  const log = readFileSync(join(repo.dir, ".cheapag", "jobs", job, "verify.log"), "utf8");
  expect(log.match(/^\$ node fail-abs\.mjs$/gm)).toHaveLength(4);
  expect(log).toMatch(/\.cheapag[\\/]worktrees[\\/]/); // the raw output, untouched
});

test("a malformed config file fails before any job starts, naming the file", async () => {
  const { text, fake } = await scenario([], "hello is 2", {
    "cheapag.json": JSON.stringify({ test_cmd: 42 }),
  });
  expect(text).toMatch(/^FAIL reason: .*cheapag\.json: test_cmd must be a non-empty string$/);
  expect(fake.recorded.sessions).toEqual([]);
});

test("without a backticked condition, the repo's cheapag.json test_cmd runs (over the user's)", async () => {
  const { text, record } = await scenario([RIGHT("set hello to 2")], "hello is 2", {
    "cheapag.json": JSON.stringify({ test_cmd: "node check.mjs" }),
    "~/config/cheapag/config.json": JSON.stringify({ test_cmd: "false" }),
  });
  expect(text.split("\n")[0]).toContain(" tests=pass ");
  expect(record.verify).toEqual([expect.objectContaining({ cmd: "node check.mjs", ok: true })]);
});

test("the user's config test_cmd applies when the repo has none", async () => {
  const { text, record } = await scenario([RIGHT("set hello to 2")], "hello is 2", {
    "~/config/cheapag/config.json": JSON.stringify({ test_cmd: "node check.mjs" }),
  });
  expect(text.split("\n")[0]).toContain(" tests=pass ");
  expect(record.verify).toEqual([expect.objectContaining({ cmd: "node check.mjs" })]);
});

test("without a backticked condition or a test_cmd, nothing runs: tests=none", async () => {
  const { text, record } = await scenario([RIGHT("set hello to 2")], "hello is 2");
  expect(text.split("\n")[0]).toContain(" tests=none ");
  expect(record.verify).toEqual([]);
});

test("errorTail strips a Windows root and forward-slashes the rest", () => {
  const run = {
    cmd: "node x",
    ok: false,
    ms: 1,
    output: "at C:\\r\\repo\\.cheapag\\worktrees\\j1/src/hello.ts:4:1",
    code: 1,
    signal: null,
  };
  expect(errorTail(run, "C:\\r\\repo").join("\n")).toContain(
    ".cheapag/worktrees/j1/src/hello.ts:4:1",
  );
});

test("a check that cannot run at all is an environment failure (exit 127), not a test failure", async () => {
  const [run] = await runVerify(process.cwd(), ["nonexistent-cmd-xyz"], () => {});
  expect(run.ok).toBe(false);
  expect(run.code).toBe(127);
  expect(run.signal).toBeNull();
  expect(envFailure(run)).toBe("exit 127: command not found");
});

test("envFailure is undefined for a pass and an ordinary test failure, and names the code, signal or loader phrase", () => {
  const run = (r: Partial<Parameters<typeof envFailure>[0]>) => ({
    cmd: "node check.mjs",
    ok: false,
    ms: 1,
    output: "",
    code: 1,
    signal: null,
    ...r,
  });
  expect(envFailure(run({ ok: true, code: 0 }))).toBeUndefined();
  expect(envFailure(run({ output: "✗ expected 2, received 1" }))).toBeUndefined();
  expect(envFailure(run({ code: 127 }))).toBe("exit 127: command not found");
  expect(envFailure(run({ code: 134 }))).toBe("exit 134 (dyld abort)");
  expect(envFailure(run({ code: null, signal: "SIGSEGV" }))).toBe("signal SIGSEGV");
  expect(
    envFailure(
      run({ code: null, signal: "SIGKILL", output: "x\n(cheapag: stopped, job cap or cancel)" }),
    ),
  ).toBeUndefined();
  expect(
    envFailure(run({ code: null, signal: "SIGKILL", output: "x\n(cheapag: stopped after 5 min)" })),
  ).toBeUndefined();
  expect(envFailure(run({ output: "Error: dyld: Library not loaded: libnode.dylib" }))).toBe(
    "exit 1: dyld",
  );
  expect(envFailure(run({ output: "exec: No such file or directory: node" }))).toBe(
    "exit 1: No such file or directory: node",
  );
});

test("checkAllows expands a compound check into the segments OpenCode checks, env assignments stripped", () => {
  expect(
    checkAllows("cd apps/dev && PATH=/x:$PATH DYLD_LIBRARY_PATH=/y node scripts/run.mjs a b"),
  ).toEqual([
    "cd apps/dev && PATH=/x:$PATH DYLD_LIBRARY_PATH=/y node scripts/run.mjs a b",
    "cd apps/dev",
    "PATH=/x:$PATH DYLD_LIBRARY_PATH=/y node scripts/run.mjs a b",
    "node scripts/run.mjs a b",
  ]);
  expect(checkAllows("npm test -- x; echo done | cat")).toEqual([
    "npm test -- x; echo done | cat",
    "npm test -- x",
    "echo done",
    "cat",
  ]);
  expect(checkAllows("export X=1 npm test")).toEqual(["export X=1 npm test", "npm test"]);
});

test("a check that cannot run (command not found) stops after one worker run: no fixes, no escalation", async () => {
  const { text, record, prompts } = await scenario(
    [RIGHT("done")],
    "`definitely-not-a-tool --version` passes",
  );
  const head = text.split("\n")[0];
  expect(head).toMatch(/^FAIL /);
  expect(head).not.toMatch(/ (fix|esc)=/);
  expect(text).toContain("environment:");
  expect(text).toMatch(/env: the check could not run \(exit 127: command not found\)/);
  expect(record.check).toBe("env");
  expect(prompts).toHaveLength(1);
});

test("a check that cannot even be spawned fails with the spawn error, no exit code and no signal", async () => {
  const [run] = await runVerify(join(import.meta.dirname, "no-such-folder"), ["true"], () => {});
  expect(run).toMatchObject({ cmd: "true", ok: false, code: null, signal: null });
  expect(run.output).toMatch(/ENOENT/);
});

test.skipIf(process.platform === "win32")(
  "a check still running after 5 minutes is killed and says so",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const started: string[] = [];
    const runs = runVerify(import.meta.dirname, ["sleep 600", "echo never"], (cmd) =>
      started.push(cmd),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const [run, ...rest] = await runs;
    expect(run).toMatchObject({ ok: false, signal: "SIGKILL" });
    expect(run.output).toBe("\n(cheapag: stopped after 5 min)");
    expect(envFailure(run)).toBeUndefined(); // our own kill is not an environment failure
    expect(rest).toEqual([]);
    expect(started).toEqual(["sleep 600"]);
  },
);

test("errorTail joins a runner's FAIL headline with the error on the next line as one failure", () => {
  const run = {
    cmd: "npm test",
    ok: false,
    ms: 1,
    code: 1,
    signal: null,
    output:
      "FAIL test/a.test.ts > adds\nAssertionError: expected 1 to be 2\n  at test/a.test.ts:3:5\n",
  };
  expect(errorTail(run, "/repo")).toEqual([
    "`npm test`",
    "  FAIL test/a.test.ts > adds",
    "    AssertionError: expected 1 to be 2",
    "    at test/a.test.ts:3:5",
  ]);
});

test("a usage limit on the escalation model: the job ends on the implement model's result, and tried: says the escalation never ran", async () => {
  const { text, job, record, prompts } = await scenario([
    WRONG("first try"),
    WRONG("second try"),
    WRONG("third try"),
    [{ retry: { reason: "account_rate_limit", message: "Go weekly limit reached" } }],
  ]);
  expect(text.split("\n")[0]).toBe(
    `FAIL ${job} step=1 files=1 +1/-1 tests=fail turns=6 cost=$0.003 fix=2`,
  ); // no esc=1, no model=
  expect(text).toContain("\nsummary: third try\n");
  expect(record.tried).toEqual([
    "fix 1: second try → same failure",
    "fix 2: third try → same failure",
    "esc: (no summary) → usage limit: Go weekly limit reached",
  ]);
  expect(record.models).toMatchObject({
    requested: "opencode-go/deepseek-v4.1-flash",
    final: "opencode-go/deepseek-v4.1-flash",
    escalated: false,
  });
  expect(prompts.map((p) => p.model?.modelID)).toEqual([
    undefined,
    undefined,
    undefined,
    "deepseek-v4-pro",
  ]);
  expect(record).toMatchObject({ status: "FAIL", landed: false, selfFix: 2 });
});

/** A failed run whose output is `output`, for errorTail. */
const failed = (output: string, cmd = "npm test") => ({
  cmd,
  ok: false,
  ms: 1,
  output,
  code: 1,
  signal: null,
});

test("verifyCommands takes the trimmed backticked fragments in order, else the test_cmd, else none", () => {
  expect(
    verifyCommands(["`npm test` then ` npx tsc `", "no command", "`  ` and `node a.mjs`"], "make"),
  ).toEqual(["npm test", "npx tsc", "node a.mjs"]);
  expect(verifyCommands(["no command", "``"], "make")).toEqual(["make"]);
  expect(verifyCommands(["no command"], "")).toEqual([]);
  expect(verifyCommands([])).toEqual([]);
});

test("checkAllows skips empty segments and repeats, and keeps an assignment with no command after it", () => {
  expect(checkAllows("CI=1 npm test && CI=1 npm test;")).toEqual([
    "CI=1 npm test && CI=1 npm test;",
    "CI=1 npm test",
    "npm test",
  ]);
  expect(checkAllows("  X=1  ")).toEqual(["X=1"]);
});

test.skipIf(process.platform === "win32")(
  "runVerify runs each command with CI=1 and FORCE_COLOR=0, keeps stderr, and stops at the first failure",
  async () => {
    const started: string[] = [];
    const runs = await runVerify(
      import.meta.dirname,
      ["echo $CI$FORCE_COLOR", "echo err 1>&2; exit 3", "echo never"],
      (cmd) => started.push(cmd),
    );
    expect(started).toEqual(["echo $CI$FORCE_COLOR", "echo err 1>&2; exit 3"]);
    expect(runs).toMatchObject([
      { cmd: "echo $CI$FORCE_COLOR", ok: true, output: "10\n", code: 0, signal: null },
      { cmd: "echo err 1>&2; exit 3", ok: false, output: "err\n", code: 3, signal: null },
    ]);
    expect(runs.map((run) => Object.keys(run))).toEqual([
      ["cmd", "ok", "ms", "output", "code", "signal"],
      ["cmd", "ok", "ms", "output", "code", "signal"],
    ]);
    expect(runs.every((run) => run.ms >= 0)).toBe(true);
  },
);

test("runVerify runs nothing when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const started: string[] = [];
  const runs = await runVerify(
    import.meta.dirname,
    ["echo never"],
    (cmd) => started.push(cmd),
    controller.signal,
  );
  expect(runs).toEqual([]);
  expect(started).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "aborting the signal kills the running check, fails it and says so",
  async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const runs = runVerify(
      import.meta.dirname,
      ["sleep 600", "echo never"],
      (cmd) => started.push(cmd),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const [run, ...rest] = await runs;
    expect(run).toMatchObject({ cmd: "sleep 600", ok: false, code: null, signal: "SIGKILL" });
    expect(run.output).toBe("\n(cheapag: stopped, job cap or cancel)");
    expect(rest).toEqual([]);
    expect(started).toEqual(["sleep 600"]);
  },
);

test("runVerify keeps only the last MiB of a check's output", async () => {
  const [run] = await runVerify(
    import.meta.dirname,
    [`node -e "process.stdout.write('a'.repeat(1048576) + 'END')"`],
    () => {},
  );
  expect(run.ok).toBe(true);
  expect(run.output).toBe("a".repeat(1048573) + "END");
});

test.skipIf(process.platform === "win32")(
  "on Windows, a check runs through Git Bash with -c when Git Bash is found",
  async () => {
    vi.stubEnv("CLAUDE_CODE_GIT_BASH_PATH", "/bin/bash");
    onTestFinished(() => void vi.unstubAllEnvs());
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    let runs: ReturnType<typeof runVerify>;
    try {
      // the shell is picked and spawned synchronously, before runVerify's first await
      runs = runVerify(import.meta.dirname, ['echo "$0" $CI'], () => {});
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const [run] = await runs;
    expect(run).toMatchObject({ ok: true, code: 0, output: "/bin/bash 1\n" });
  },
);

test("envFailure says ? when a loader phrase comes with no exit code", () => {
  const run = { ...failed("sh: foo: Command Not Found"), code: null };
  expect(envFailure(run)).toBe("exit ?: Command Not Found");
});

test("errorTail falls back to the last 24 lines, without ANSI codes, pass lines, progress or blank lines", () => {
  const numbered = Array.from({ length: 26 }, (_, n) => `\tline ${n}   `);
  const output = [
    ...numbered.slice(0, 13),
    "\x1b[32m ✓ a › passes\x1b[0m\r",
    "PASS src/a.test.ts",
    "Test Files  1 passed (1)",
    "  Tests  3 passed (3)",
    "Tests: 1 failed, 2 passed",
    "⠋⠙",
    "...",
    "ok 1 - fine",
    "",
    "   ",
    ...numbered.slice(13),
  ].join("\n");
  expect(errorTail(failed(output), "/repo")).toEqual([
    "`npm test`",
    ...Array.from({ length: 24 }, (_, n) => `    line ${n + 2}`),
  ]);
});

test("errorTail makes paths under root repo-relative, escaping the root and forward-slashing the rest", () => {
  const root = "/tmp/r(1)+repo";
  const output = [
    `boom at ${root}/src/a.ts:3:1`,
    `    at fn (${root}/src\\win\\b.ts:4:2)`,
    `    at '${root}/lib/c.js'`,
    `see "${root}/d e.ts" and [${root}/f.ts]`,
    root,
    `${root}X/g.ts`,
  ].join("\n");
  expect(errorTail(failed(output, "x"), root)).toEqual([
    "`x`",
    "  boom at src/a.ts:3:1",
    "      at fn (src/win/b.ts:4:2)",
    "      at 'lib/c.js'",
    '  see "d e.ts" and [f.ts]',
    "  /tmp/r(1)+repo",
    "  /tmp/r(1)+repoX/g.ts",
  ]);
});

test("errorTail strips a native Windows root, and the forward-slash form only where the path separator is a backslash", () => {
  const output = "at C:\\r\\repo\\src\\a.ts:1 and C:\\r\\repo/lib\\b.ts and C:/r/repo/src/c.ts:2";
  const forwardSlashed = sep === "\\" ? "src/c.ts:2" : "C:/r/repo/src/c.ts:2";
  expect(errorTail(failed(output), "C:\\r\\repo")).toEqual([
    "`npm test`",
    `  at src/a.ts:1 and lib/b.ts and ${forwardSlashed}`,
  ]);
});

test("errorTail keeps 3 distinct failures: details up to 4, the first in-repo frame, repeats counted, within 12 lines", () => {
  const output = [
    "✗ item 1 not ready",
    "  expected 1",
    "  received 2",
    "  - a",
    "  + b",
    "  got 3",
    "    at node_modules/x/y.js:1:1",
    "    at src/item.ts:9:9",
    "    at src/other.ts:1:1",
    "✗ item 2 not ready",
    "  expected 5",
    "✗ item 3 not ready",
    "thread panicked: far frame",
    ...Array.from({ length: 12 }, (_, n) => `filler ${n}`),
    "    at src/late.ts:1:1",
    "FAIL x > y",
    "AssertionError: z",
    "✘ dropped",
  ].join("\n");
  expect(errorTail(failed(output), "/repo")).toEqual([
    "`npm test`",
    "  ✗ item 1 not ready (×3)",
    "    expected 1",
    "    received 2",
    "    - a",
    "    + b",
    "    at src/item.ts:9:9",
    "  thread panicked: far frame",
    "  FAIL x > y",
    "    AssertionError: z",
  ]);
});

test("errorTail keeps a marker line that looks like a pass, a detail line that looks like a frame stays a detail, and a repeat counts ×2", () => {
  const output = "✓ cached Error: stale\n✗ t\n  expected src/a.ts:1:1\n    at src/b.ts:2:2\n✗ t\n";
  expect(errorTail(failed(output, "c"), "/repo")).toEqual([
    "`c`",
    "  ✓ cached Error: stale",
    "  ✗ t (×2)",
    "    expected src/a.ts:1:1",
    "    at src/b.ts:2:2",
  ]);
});

test("errorTail reads Python failures: Traceback, the first frame outside site-packages, and E lines", () => {
  const output = [
    "Traceback (most recent call last):",
    '  File "/usr/lib/python3/site-packages/x.py", line 1, in <module>',
    '  File "t.py", line 3, in test',
    "E   assert 1 == 2",
    "E   +  where 1 = f()",
  ].join("\n");
  expect(errorTail(failed(output, "pytest"), "/repo")).toEqual([
    "`pytest`",
    "  Traceback (most recent call last):",
    '    File "t.py", line 3, in test',
    "  E   assert 1 == 2",
    "  E   +  where 1 = f()",
  ]);
});

test("errorTail joins a headline with the next line only when that line is an Error and both fit under 400 chars", () => {
  const separate = "FAIL a > b\nFAIL c > d\n× e\nError: " + "x".repeat(390);
  expect(errorTail(failed(separate), "/repo")).toEqual([
    "`npm test`",
    "  FAIL a > b",
    "  FAIL c > d",
    "  × e",
  ]);
  const joined = "× e\nError: " + "x".repeat(389);
  expect(errorTail(failed(joined), "/repo")).toEqual([
    "`npm test`",
    "  × e",
    `    Error: ${"x".repeat(109)} … ${"x".repeat(77)}`,
  ]);
});

test("errorTail clips a line over 200 chars to its first 120 and last 77", () => {
  const output = `${"a".repeat(198)}\n${"b".repeat(100)}${"c".repeat(99)}`;
  expect(errorTail(failed(output), "/repo")).toEqual([
    "`npm test`",
    `  ${"a".repeat(198)}`,
    `  ${"b".repeat(100)}${"c".repeat(18)} … ${"c".repeat(77)}`,
  ]);
});

test("sameFailure compares the joined tails with every number ignored", () => {
  expect(sameFailure(["`t`", "  ✗ a 1 (12ms)"], ["`t`", "  ✗ a 2 (7ms)"])).toBe(true);
  expect(sameFailure(["x", "y"], ["x\ny"])).toBe(true);
  expect(sameFailure(["`t`", "  ✗ a"], ["`t`", "  ✗ b"])).toBe(false);
});
