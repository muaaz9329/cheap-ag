import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo, type Logins } from "./harness.js";
import { PLAN_FORMAT } from "../src/plan.js";

const PLAN = `# Hello feature
Keep it tiny.

## 1 hello module
files: src/hello.ts, README.md
do: export a hello constant
  and mention it in the README.
done-when: hello is exported
`;

const REPORT = { summary: "added hello constant and README note", risks: ["none known"], review: ["src/hello.ts:1-1", "../outside.ts:1-2"], missing: [] };

/** A repo with the plan written (uncommitted), a fake worker scripted with `actions`, and a server on both. */
async function scenario(actions: Action[] | null, plan = PLAN, logins: Logins = { "opencode-go": "go-key" }) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "hello.md"), plan);
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  if (actions) fake.script(...actions);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins, allow: [] });
  onTestFinished(server.close);
  const progress: string[] = [];
  const delegate = async (steps: string, note?: string, planPath = ".plan/hello.md") => {
    const result = await server.client.callTool({ name: "delegate", arguments: { plan: planPath, steps, ...(note && { note }) } }, undefined, {
      onprogress: (p) => void progress.push(p.message ?? ""),
    });
    return (result.content as { text: string }[])[0].text;
  };
  return { repo, fake, delegate, progress };
}

const jobOf = (text: string) => text.match(/^\w+ (j[0-9a-z]{4}) /)![1];

test("a single step runs in a worktree and lands OK, uncommitted, with the result block and job record", async () => {
  const { repo, fake, delegate, progress } = await scenario([
    { edit: "src/hello.ts", content: "export const hello = 1;\n" },
    { tool: "write", input: { filePath: "src/hello.ts" } },
    { edit: "README.md", content: "# fixture\n\nhello lives in src/hello.ts\n" },
    { tool: "edit", input: { filePath: "README.md" } },
    { usage: { cost: 0.0015, input: 900, output: 40 } },
    { usage: { cost: 0.0005, input: 300, output: 10 } },
    { finish: REPORT },
  ]);
  // an unrelated change the user has staged must stay staged
  writeFileSync(join(repo.dir, "staged.txt"), "mine\n");
  repo.git("add", "staged.txt");

  const text = await delegate("1", "keep it short");
  const job = jobOf(text);
  expect(text).toBe([
    `OK ${job} step=1 files=2 +3/-0 tests=none turns=3 cost=$0.002`,
    "summary: added hello constant and README note",
    "changed:",
    "  M README.md +2",
    "  A src/hello.ts +1",
    "risks:",
    "  - none known",
    "review: src/hello.ts:1-1",
    `log: .cheapag/jobs/${job}/`,
  ].join("\n"));

  // landed into the working tree, nothing committed, the user's index untouched
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 1;\n");
  expect(repo.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  expect(repo.git("status", "--porcelain", "--untracked-files=all", "--", "README.md", "src", "staged.txt")).toBe(" M README.md\nA  staged.txt\n?? src/hello.ts\n");

  // the worker ran in its own detached worktree, which is gone after landing
  const [session] = fake.recorded.sessions;
  expect(session.directory).toBe(join(repo.dir, ".cheapag", "worktrees", job));
  expect(session).toMatchObject({ agent: "cheapag-worker", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } });
  expect(existsSync(session.directory)).toBe(false);
  expect(repo.git("worktree", "list").trim().split("\n")).toHaveLength(1);

  const prompt = (fake.recorded.prompts[0].parts[0] as { text: string }).text;
  expect(prompt).toMatch(/^# Hello feature\n\nKeep it tiny\.\n\n## 1 hello module\n/); // the whole plan first
  expect(prompt).toContain("\n\n>>> CURRENT STEP(S): 1\n\n## 1 hello module\n");
  expect(prompt.endsWith("\n\nNote: keep it short")).toBe(true);

  // one progress notification per worker turn
  expect(progress).toEqual(["turn 1: write", "turn 2: edit", "turn 3: finish"]);

  const dir = join(repo.dir, ".cheapag", "jobs", job);
  expect(readdirSync(dir).sort()).toEqual(["diff.patch", "events.jsonl", "finish.json", "request.json", "result.json", "result.txt"]);
  expect(JSON.parse(readFileSync(join(dir, "finish.json"), "utf8"))).toEqual(REPORT);
  expect(readFileSync(join(dir, "result.txt"), "utf8")).toBe(text + "\n");
  expect(readFileSync(join(dir, "diff.patch"), "utf8")).toContain("+export const hello = 1;");
  expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toMatchObject({
    format: "cheapag/1", job, status: "OK", landed: true, plan: ".plan/hello.md", steps: "1",
    baseline: { head: repo.git("rev-parse", "HEAD").trim() }, sessionID: session.id,
    usage: { turns: 3, costUsd: 0.002, inputTokens: 1200, outputTokens: 50 },
  });
});

test.each([
  ["an unknown step id", PLAN, "9", "FAIL reason: plan .plan/hello.md: step 9 not found (plan steps: 1)"],
  ["a range (not supported yet)", PLAN, "1-2", 'FAIL reason: plan .plan/hello.md: steps "1-2": only a single step id is supported yet; delegate one step at a time'],
  ["a plan path outside the repo", PLAN, "1", null],
  ["a step missing done-when", "# T\n## 1 a\nfiles: a.ts\n", "1", `FAIL reason: plan .plan/hello.md: step 1 (line 2): missing done-when:\n${PLAN_FORMAT}`],
  ["a heading without an id", "# T\n## add things\nfiles: a\ndone-when: x\n", "1", `FAIL reason: plan .plan/hello.md: line 2: step heading needs an id (integer or integer+letter), e.g. "## 3 add route"\n${PLAN_FORMAT}`],
  ["bulleted keys with no H1 (as Claude first wrote it)", "## 1 greet\n\n- files: src/greet.js\n- done-when: exists\n", "1", `FAIL reason: plan .plan/hello.md: line 1: step before the plan's H1 title\n${PLAN_FORMAT}`],
] as const)("%s fails immediately without starting a job", async (_, plan, steps, expected) => {
  const { repo, fake, delegate } = await scenario(null, plan);
  if (expected === null) {
    expect(await delegate(steps, undefined, "../outside.md")).toBe("FAIL reason: plan ../outside.md must be a path inside the repository, relative to its root");
  } else {
    expect(await delegate(steps)).toBe(expected);
  }
  expect(fake.recorded.sessions).toEqual([]);
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
});

test("without finish, the fenced cheapag-result block is used", async () => {
  const { delegate } = await scenario([
    { edit: "src/hello.ts", content: "export const hello = 1;\n" },
    { tool: "write" },
    { text: "Done.\n```cheapag-result\nsummary: wrote hello\nrisks:\n- untested\nreview: src/hello.ts:1-1\nmissing:\n```" },
  ]);
  const text = await delegate("1");
  expect(text).toContain("\nsummary: wrote hello\n");
  expect(text).toContain("\nrisks:\n  - untested\nreview: src/hello.ts:1-1\n");
});

test("with neither finish nor a result block, a placeholder summary and risk are reported", async () => {
  const { delegate } = await scenario([{ edit: "src/hello.ts", content: "x\n" }, { tool: "write" }]);
  const text = await delegate("1");
  expect(text).toMatch(/^OK /);
  expect(text).toContain("\nsummary: (worker gave no summary)\n");
  expect(text).toContain("\nrisks:\n  - worker did not report; review diff\n");
});

test("a worker error is a FAIL: nothing lands and the worktree is kept", async () => {
  const { repo, delegate } = await scenario([{ edit: "src/hello.ts", content: "x\n" }, { error: { name: "APIError", message: "upstream 500" } }]);
  const text = await delegate("1");
  const job = jobOf(text);
  expect(text.split("\n")[0]).toMatch(new RegExp(`^FAIL ${job} step=1 files=1 `));
  expect(text).toContain("\nreason: worker error: upstream 500\n");
  expect(text).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job, "src/hello.ts"))).toBe(true);
});

test("an error reported only on the assistant message (no session.error) is still a FAIL", async () => {
  const { repo, delegate } = await scenario([{ edit: "src/hello.ts", content: "x\n" }, { error: { name: "APIError", message: "Insufficient credits" }, on: "message" }]);
  const text = await delegate("1");
  expect(text).toMatch(/^FAIL /);
  expect(text).toContain("\nreason: worker error: Insufficient credits\n");
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
});

test("an uncommitted edit the developer made before delegating is the worker's starting point, not a conflict", async () => {
  let dir = "";
  const { repo, delegate } = await scenario([{ edit: "README.md", content: "# fixture\n\nmine\nworker's line\n" }, { tool: "edit" }, { finish: REPORT }]);
  dir = repo.dir;
  writeFileSync(join(dir, "README.md"), "# fixture\n\nmine\n");
  const text = await delegate("1");
  expect(text).toMatch(/^OK /);
  expect(text).toContain("\n  M README.md +1\n"); // only the worker's line, not the developer's
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# fixture\n\nmine\nworker's line\n");
});

test("a landing conflict leaves the working tree untouched and keeps the worktree", async () => {
  let dir = "";
  const { repo, delegate } = await scenario([
    { edit: "README.md", content: "# worker's title\n" },
    // the developer edits the same line in the main checkout while the job runs
    { hook: () => writeFileSync(join(dir, "README.md"), "# user's title\n") },
    { tool: "edit" },
    { finish: REPORT },
  ]);
  dir = repo.dir;
  const text = await delegate("1");
  expect(text).toMatch(/^FAIL /);
  expect(text).toContain("\nreason: landing conflict, working tree untouched");
  expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toBe("# user's title\n");
  expect(repo.git("status", "--porcelain", "--", "README.md")).toBe(" M README.md\n");
});

test("key-shaped strings in the worker's code land intact; only the log copy is redacted", async () => {
  const code = 'export const example = "sk-docsEXAMPLE0123456789abcdef";\n';
  const { repo, delegate } = await scenario([{ edit: "src/hello.ts", content: code }, { tool: "write" }, { finish: REPORT }]);
  const job = jobOf(await delegate("1"));
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe(code);
  const log = readFileSync(join(repo.dir, ".cheapag", "jobs", job, "diff.patch"), "utf8");
  expect(log).not.toContain("sk-docsEXAMPLE");
  expect(log).toContain("[redacted]");
});

test("a worker stream that ends before idle is a FAIL with a full record, not an OK", async () => {
  const { repo, fake, delegate } = await scenario([{ edit: "src/hello.ts", content: "x\n" }, { question: "Which?", options: ["a", "b"] }]);
  const pending = delegate("1");
  await vi.waitFor(() => expect(fake.recorded.prompts).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 50));
  await fake.close(); // the server goes away mid-run
  const text = await pending;
  const job = jobOf(text);
  expect(text).toMatch(/^FAIL /);
  expect(text).toContain("\nreason: worker error: worker event stream ended before the session went idle\n");
  expect(existsSync(join(repo.dir, "src/hello.ts"))).toBe(false);
  expect(JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"))).toMatchObject({ status: "FAIL", landed: false, worktree: `.cheapag/worktrees/${job}` });
});

test("with only an OpenRouter login, the job runs on an openrouter model and lands OK", async () => {
  const { repo, fake, delegate } = await scenario(
    [{ edit: "src/hello.ts", content: "export const hello = 1;\n" }, { tool: "write" }, { usage: { cost: 0.0004 } }, { finish: REPORT }],
    PLAN,
    { openrouter: "sk-or-v1-testkeytestkeytestkey" },
  );
  const text = await delegate("1");
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1 files=1 \+1\/-0 tests=none turns=2 cost=\$0\.000\n/);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 1;\n");
  expect(JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", jobOf(text), "result.json"), "utf8"))).toMatchObject({
    provider: "openrouter", models: { requested: "openrouter/deepseek/deepseek-v4.1-flash" },
  });
});

test("every worker session carries the ruleset: catch-all deny first, project scripts allowed, hard denylist last", async () => {
  const { repo, fake, delegate } = await scenario([{ finish: REPORT }], PLAN.replace("done-when: hello is exported", "done-when: `node check.mjs` passes"));
  writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  repo.git("add", "package.json");
  repo.git("commit", "-q", "-m", "pkg");
  mkdirSync(join(repo.dir, "node_modules"));
  await delegate("1");
  const rules = fake.recorded.sessions[0].permission as { permission: string; pattern: string; action: string }[];
  expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
  expect(rules).toContainEqual({ permission: "bash", pattern: "npm run lint", action: "allow" });
  expect(rules).toContainEqual({ permission: "bash", pattern: "npx tsc --noEmit", action: "allow" }); // allow_commands default
  expect(rules).toContainEqual({ permission: "bash", pattern: "node check.mjs", action: "allow" }); // the step's done-when command
  expect(rules).toContainEqual({ permission: "edit", pattern: "node_modules/**", action: "deny" }); // the linked dir
  expect(rules).toContainEqual({ permission: "external_directory", pattern: "*", action: "deny" });
  // custom tools are permission-checked by name: without this the catch-all hides finish (seen live)
  expect(rules).toContainEqual({ permission: "finish", pattern: "*", action: "allow" });
  expect(rules.at(-1)).toMatchObject({ permission: "bash", action: "deny" });
  expect(rules).toContainEqual({ permission: "bash", pattern: "chmod -R*", action: "deny" });
  // the hard denylist comes after every allow, so no script or config can loosen it
  const lastAllow = rules.map((r) => r.action).lastIndexOf("allow");
  expect(rules.findIndex((r) => r.pattern === "npm install*")).toBeGreaterThan(lastAllow);
});

test("a permission request is auto-rejected with a reason, so the job never hangs; it is recorded", async () => {
  const { repo, fake, delegate } = await scenario([
    { permission: "bash", patterns: ["npm install zod"] },
    { edit: "src/hello.ts", content: "x\n" },
    { tool: "write" },
    { finish: REPORT },
  ]);
  const text = await delegate("1");
  expect(text).toMatch(/^OK /);
  expect(fake.recorded.permissionReplies).toEqual([{
    requestID: expect.any(String), reply: "reject",
    message: "Not allowed in cheapag: `npm install zod`. If you need a dependency, use the question tool. Otherwise finish and list it in risks.",
  }]);
  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", jobOf(text), "result.json"), "utf8"));
  expect(record.autoRejected).toEqual([{ kind: "asked", permission: "bash", what: "npm install zod" }]);
  expect(text).not.toContain("rejected; check"); // 5 or fewer: no risk line
});

test("more than 5 rejections in a job put a risk line first", async () => {
  const asks: Action[] = Array.from({ length: 6 }, (_, i) => ({ permission: "bash", patterns: [`curl https://x/${i}`] }));
  const { delegate } = await scenario([...asks, { finish: REPORT }]);
  const text = await delegate("1");
  expect(text).toContain("\nrisks:\n  - 6 tool calls or permission requests were rejected; check the worker stayed in scope (see the log)\n  - none known\n");
});
