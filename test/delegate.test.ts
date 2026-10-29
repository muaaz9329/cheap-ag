import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { snapshot, startServer, tempRepo, type Logins } from "./harness.js";
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

test("an inline task runs as a one-step job without a plan file, and lands OK", async () => {
  const { repo, fake, server } = await scenarioWithServer([{ edit: "src/inline.ts", content: "export const inline = 1;\n" }, { finish: { summary: "added inline", risks: [], review: [], missing: [] } }]);
  const call = async (args: Record<string, unknown>) => ((await server.client.callTool({ name: "delegate", arguments: args })).content as { text: string }[])[0].text;
  const text = await call({ task: "Add src/inline.ts exporting inline = 1", files: "src/inline.ts" });
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1 /);
  expect(readFileSync(join(repo.dir, "src", "inline.ts"), "utf8")).toBe("export const inline = 1;\n");
  const plans = readdirSync(join(repo.dir, ".cheapag", "plans"));
  expect(plans).toHaveLength(1);
  const plan = readFileSync(join(repo.dir, ".cheapag", "plans", plans[0]), "utf8");
  expect(plan).toContain("files: src/inline.ts");
  expect(plan).toContain("do: Add src/inline.ts exporting inline = 1");
  expect(JSON.stringify(fake.recorded.prompts[0].parts)).toContain("Add src/inline.ts exporting inline = 1");
  // neither form, both forms, or an empty task fail before any job
  expect(await call({})).toBe("FAIL reason: give task (what to change, files, how to check), or plan and steps");
  expect(await call({ task: "x", plan: ".plan/hello.md", steps: "1" })).toBe("FAIL reason: give either task, or plan and steps, not both");
  expect(await call({ task: "  " })).toBe("FAIL reason: task is empty: say what to change, in which files, and how to check it");
});

test("brief: a research id or text reaches the worker's prompt; an unknown id FAILs before any job", async () => {
  const done: Action[] = [{ edit: "src/inline.ts", content: "export const inline = 1;\n" }, { finish: { summary: "added", risks: [], review: [], missing: [] } }];
  const { repo, fake, server } = await scenarioWithServer(done);
  fake.script(...done);
  const call = async (args: Record<string, unknown>) => ((await server.client.callTool({ name: "delegate", arguments: args })).content as { text: string }[])[0].text;
  // a research log, as research leaves it
  mkdirSync(join(repo.dir, ".cheapag", "jobs", "r5k2q"), { recursive: true });
  writeFileSync(join(repo.dir, ".cheapag", "jobs", "r5k2q", "result.txt"), "ANSWER r5k2q files_read=2 turns=3 cost=$0.001\nfiles: src/auth.ts:18-22\nrepro: `pytest -k expiry` → 1 failed\n");
  expect(await call({ task: "Fix expiry", brief: "r5k2q" })).toMatch(/^OK /);
  const prompt = JSON.stringify(fake.recorded.prompts[0].parts);
  expect(prompt).toContain("Scout brief (from research; start here, and check anything marked unverified):");
  expect(prompt).toContain("files: src/auth.ts:18-22");
  expect(await call({ task: "Fix expiry again", plan: undefined, brief: "auth lives in src/auth.ts" })).toMatch(/^OK /);
  expect(JSON.stringify(fake.recorded.prompts[1].parts)).toContain("auth lives in src/auth.ts");
  expect(await call({ task: "x", brief: "rzzzz" })).toBe("FAIL reason: brief rzzzz: no research with that id (cleaned up?); pass the brief's text instead");
});

/** scenario() plus the raw server, for calls with arbitrary arguments. */
async function scenarioWithServer(actions: Action[]) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "hello.md"), PLAN);
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(...actions);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "go-key" }, allow: [] });
  onTestFinished(server.close);
  return { repo, fake, server };
}

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
  // the instance for the worktree's directory is disposed before the worktree is removed
  expect(fake.recorded.disposed).toContain(join(repo.dir, ".cheapag", "worktrees", job));
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
  ["an unknown id in a group list", PLAN, "1,9", "FAIL reason: plan .plan/hello.md: step 9 not found (plan steps: 1)"],
  ["a malformed steps string", PLAN, "1;2", 'FAIL reason: plan .plan/hello.md: steps "1;2": "1;2" is not a step id or range; use e.g. "3", "3-5" or "1-2,3,4"'],
  ["a step in two groups", PLAN, "1,1", 'FAIL reason: plan .plan/hello.md: steps "1,1": step 1 is in more than one group'],
  ["a plan path outside the repo", PLAN, "1", null],
  ["a step missing done-when", "# T\n## 1 a\nfiles: a.ts\n", "1", `FAIL reason: plan .plan/hello.md: step 1 (line 2): missing done-when:\n${PLAN_FORMAT}`],
  ["a heading without an id", "# T\n## add things\nfiles: a\ndone-when: x\n", "1", `FAIL reason: plan .plan/hello.md: line 2: step heading needs an id (e.g. "## 3", "## s1", "## step-2", optionally with a letter like "3a")\n${PLAN_FORMAT}`],
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
    { text: "Done.\n```cheapag-result\nsummary: wrote hello\nrisks:\n- untested\nreview: src/hello.ts:1-1\nmissing:\ndisagree: the step says reversed MRO, the source walks it forwards\n```" },
  ]);
  const text = await delegate("1");
  expect(text).toContain("\nsummary: wrote hello\n");
  // the server puts a disagreement first, so the risk cap never cuts it (ticket 28)
  expect(text).toContain("\nrisks:\n  - spec vs source: the step says reversed MRO, the source walks it forwards\n  - untested\nreview: src/hello.ts:1-1\n");
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

test("a landing conflict the redo cannot reconcile is CONFLICT: the working tree is byte-identical, the worktree kept", async () => {
  let dir = "";
  let before: ReturnType<typeof snapshot> | undefined;
  const { repo, fake, delegate } = await scenario([
    { edit: "README.md", content: "# worker's title\n" },
    // the developer edits the same line in the main checkout while the job runs
    { hook: () => (writeFileSync(join(dir, "README.md"), "# user's title\n"), (before = snapshot(dir))) },
    { tool: "edit" },
    { finish: REPORT },
  ]); // the redo prompt gets no script: the worker leaves the conflict markers in place
  dir = repo.dir;
  const text = await delegate("1");
  const job = jobOf(text);
  expect(text).toMatch(new RegExp(`^CONFLICT ${job} step=1 files=1 .* redo=1\n`));
  expect(text).toContain(`\nconflict:\n  README.md (changed in the working tree meanwhile; redo left conflict markers)\nworktree: .cheapag/worktrees/${job}/\nlog: .cheapag/jobs/${job}/`);
  expect(snapshot(repo.dir)).toEqual(before);
  expect(fake.recorded.prompts).toHaveLength(2); // exactly one redo
  // the redo's worktree holds the change applied again, with the clash marked
  expect(readFileSync(join(repo.dir, ".cheapag", "worktrees", job, "README.md"), "utf8")).toMatch(/^<<<<<<< [\s\S]*# user's title\n=======\n# worker's title\n>>>>>>> /);
  expect(JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"))).toMatchObject({
    status: "CONFLICT", landed: false, redo: 1, worktree: `.cheapag/worktrees/${job}`,
  });
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
  const { repo, fake, delegate } = await scenario([{ edit: "src/hello.ts", content: "x\n" }, { wait: 60_000 }]);
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
