import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";
import { errorTail } from "../src/verify.js";

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

const plan = (doneWhen: string) => `# Hello\n\n## 1 hello two\nfiles: src/hello.ts\ndo: export hello = 2\ndone-when: ${doneWhen}\n`;
const WRONG = (summary: string): Action[] => [{ edit: "src/hello.ts", content: "export const hello = 1;\n" }, { tool: "write" }, { usage: { cost: 0.001 } }, { finish: { summary, risks: [], review: ["src/hello.ts:1-1"], missing: [] } }];
const RIGHT = (summary: string): Action[] => [{ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, { usage: { cost: 0.001 } }, { finish: { summary, risks: [], review: ["src/hello.ts:1-1"], missing: [] } }];

async function scenario(scripts: Action[][], doneWhen = "`node check.mjs` passes", files: Record<string, string> = {}) {
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
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(path.startsWith("~/") ? server.home : repo.dir, path.replace(/^~\//, ""), ".."), { recursive: true });
    writeFileSync(join(path.startsWith("~/") ? server.home : repo.dir, path.replace(/^~\//, "")), content);
  }
  const result = await server.client.callTool({ name: "delegate", arguments: { plan: ".plan/p.md", steps: "1" } });
  const text = (result.content as { text: string }[])[0].text;
  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)?.[1] ?? "(no job)"; // pre-job FAILs carry no id
  const record = job === "(no job)" ? undefined : JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  const prompts = fake.recorded.prompts.map((p) => ({ ...p, text: (p.parts[0] as { text: string }).text }));
  return { repo, fake, text, job, record, prompts };
}

test("verify passes first time: OK, tests=pass, landed, no fix", async () => {
  const { repo, text, record } = await scenario([RIGHT("set hello to 2")]);
  expect(text.split("\n")[0]).toMatch(/^OK j[0-9a-z]{4} step=1 files=1 \+1\/-1 tests=pass turns=2 cost=\$0\.001$/);
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  expect(record).toMatchObject({ status: "OK", landed: true, selfFix: 0, verify: [{ cmd: "node check.mjs", ok: true }], tried: [] });
});

test("verify passes after a self-fix in the same session: OK fix=1, landed", async () => {
  const { repo, fake, text, record, prompts } = await scenario([WRONG("set hello to 1"), RIGHT("corrected hello to 2")]);
  expect(text.split("\n")[0]).toMatch(/^OK j[0-9a-z]{4} step=1 files=1 \+1\/-1 tests=pass turns=4 cost=\$0\.002 fix=1$/);
  expect(text).toContain("\nsummary: corrected hello to 2\n");
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  // the fix went to the same session, on the same model, with the error tail
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(prompts.map((p) => p.sessionID)).toEqual([fake.recorded.sessions[0].id, fake.recorded.sessions[0].id]);
  expect(prompts[1].model).toBeUndefined();
  expect(prompts[1].text).toMatch(/^Verification failed\. Fix the cause, then call finish again\.\n\n`node check\.mjs`\n  ✗ hello › equals 2\n/);
  expect(record).toMatchObject({ selfFix: 1, tried: ["fix 1: corrected hello to 2 → passed"], verify: [{ ok: false }, { ok: true }] });
});

test("still failing after 2 self-fixes and the escalation: FAIL with error, tried, review and worktree; nothing lands", async () => {
  const { repo, text, job, record, prompts } = await scenario([WRONG("first try"), WRONG("second try"), WRONG("third try"), WRONG("stronger try")]);
  expect(text).toBe([
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
  ].join("\n"));
  // the escalation was the same session on the escalation model
  expect(prompts.map((p) => p.model)).toEqual([undefined, undefined, undefined, { providerID: "opencode-go", modelID: "deepseek-v4-pro" }]);
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 0;\n");
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(record).toMatchObject({
    status: "FAIL", landed: false, selfFix: 2, tests: "fail",
    models: { requested: "opencode-go/deepseek-v4.1-flash", final: "opencode-go/deepseek-v4-pro", escalated: true },
  });
  expect(record.verify).toHaveLength(4);
});

test("a worker error during a self-fix is a FAIL with its reason; nothing lands", async () => {
  const { repo, text } = await scenario([WRONG("first try"), [{ error: { name: "APIError", message: "upstream 500" } }]]);
  expect(text.split("\n")[0]).toMatch(/^FAIL .* tests=fail .* fix=1$/);
  expect(text).toContain("\ntried:\n  - fix 1: (no summary) → worker error\n");
  expect(text).toContain("\nreason: worker error: upstream 500\n");
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 0;\n");
});

test("a worker error before verification reports tests=none, not fail", async () => {
  const { text, record } = await scenario([[{ error: { name: "APIError", message: "upstream 500" } }]]);
  expect(text.split("\n")[0]).toContain(" tests=none ");
  expect(record.verify).toEqual([]);
});

test("the error tail keeps a failure line that mentions 'passed' and makes worktree paths repo-relative; verify.log has it all", async () => {
  const { repo, job, text } = await scenario([WRONG("a"), WRONG("b"), WRONG("c"), WRONG("d")], "`node fail-abs.mjs` succeeds");
  expect(text).toContain("\nerror: `node fail-abs.mjs`\n  TypeError: 3 arguments passed, expected 2\n    at src/hello.ts:4:1\n");
  const log = readFileSync(join(repo.dir, ".cheapag", "jobs", job, "verify.log"), "utf8");
  expect(log.match(/^\$ node fail-abs\.mjs$/gm)).toHaveLength(4);
  expect(log).toContain(".cheapag/worktrees/"); // the raw output, untouched
});

test("a malformed config file fails before any job starts, naming the file", async () => {
  const { text, fake } = await scenario([], "hello is 2", { "cheapag.json": JSON.stringify({ test_cmd: 42 }) });
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
  const { text, record } = await scenario([RIGHT("set hello to 2")], "hello is 2", { "~/config/cheapag/config.json": JSON.stringify({ test_cmd: "node check.mjs" }) });
  expect(text.split("\n")[0]).toContain(" tests=pass ");
  expect(record.verify).toEqual([expect.objectContaining({ cmd: "node check.mjs" })]);
});

test("without a backticked condition or a test_cmd, nothing runs: tests=none", async () => {
  const { text, record } = await scenario([RIGHT("set hello to 2")], "hello is 2");
  expect(text.split("\n")[0]).toContain(" tests=none ");
  expect(record.verify).toEqual([]);
});

test("errorTail strips a Windows root and forward-slashes the rest", () => {
  const run = { cmd: "node x", ok: false, ms: 1, output: "at C:\\r\\repo\\.cheapag\\worktrees\\j1/src/hello.ts:4:1" };
  expect(errorTail(run, "C:\\r\\repo").join("\n")).toContain(".cheapag/worktrees/j1/src/hello.ts:4:1");
});
