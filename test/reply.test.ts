import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { allowRepo, homeEnv, slow, startServer, tempRepo } from "./harness.js";

const PLAN =
  "# Rate limit\n\n## 1 limit login\nfiles: src/hello.ts\ndo: export hello = 2\ndone-when: `node check.mjs` passes\n";
const CHECK = `import { readFileSync } from "node:fs";
if (readFileSync("src/hello.ts", "utf8").trim() === "export const hello = 2;") process.exit(0);
console.log("Error: hello is not 2");
process.exit(1);
`;
const OPTIONS = [
  "run before lockout (counts all attempts)",
  "run after lockout (counts only non-locked users)",
  "replace lockout entirely",
];
const ASK: Action = {
  question: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
  options: OPTIONS,
};
const edit = (value: number, summary: string): Action[] => [
  { edit: "src/hello.ts", content: `export const hello = ${value};\n` },
  { tool: "write" },
  { usage: { cost: 0.001 } },
  { finish: { summary, risks: [], review: [], missing: [] } },
];

async function scenario(...scripts: Action[][]) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "check.mjs"), CHECK);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "hello.ts"), "export const hello = 0;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "check");
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "p.md"), PLAN);
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
  const call = async (name: string, args: Record<string, string>) =>
    ((await server.client.callTool({ name, arguments: args })).content as { text: string }[])[0]
      .text;
  const record = (job: string) =>
    JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  return {
    repo,
    fake,
    record,
    home: server.home,
    delegate: () => call("delegate", { plan: ".plan/p.md", steps: "1" }),
    reply: (job: string, answer: string) => call("reply", { job, answer }),
    jobs: (action: string, job: string) => call("jobs", { action, job }),
    call,
  };
}

const jobOf = (text: string) => text.match(/^\w+ (j[0-9a-z]{4}) /)![1];

test("an ambiguous step → BLOCKED with lettered options; a letter reply resumes the same session and lands OK", async () => {
  const { repo, fake, record, delegate, reply } = await scenario([
    { tool: "read" },
    ASK,
    ...edit(2, "rate limit runs after lockout"),
  ]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe(
    [
      `BLOCKED ${job} step=1 files=0 +0/-0 turns=1 cost=$0.000`,
      "question: login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
      "options:",
      "  a) run before lockout (counts all attempts)",
      "  b) run after lockout (counts only non-locked users)",
      "  c) replace lockout entirely",
      `log: .cheapag/jobs/${job}/`,
    ].join("\n"),
  );
  // paused, not rejected: the record says BLOCKED and the worktree is still there
  expect(fake.recorded.questionReplies).toEqual([]);
  expect(record(job)).toMatchObject({
    status: "BLOCKED",
    landed: false,
    question: { text: ASK.question, options: OPTIONS, answer: null },
    worktree: `.cheapag/worktrees/${job}`,
  });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);

  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(
    new RegExp(`^OK ${job} step=1 files=1 \\+1/-1 tests=pass turns=3 cost=\\$0\\.001$`),
  );
  expect(fake.recorded.questionReplies).toEqual([
    { requestID: expect.any(String), answers: [[OPTIONS[1]]], rejected: false },
  ]);
  // the same session carried on: one session, one prompt
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([fake.recorded.sessions[0].id]);
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  expect(record(job)).toMatchObject({
    status: "OK",
    landed: true,
    sessionID: fake.recorded.sessions[0].id,
    question: { answer: OPTIONS[1] },
  });

  // it is no longer BLOCKED
  expect(await reply(job, "a")).toBe(
    `FAIL reason: job ${job} is OK, not BLOCKED; only a BLOCKED job takes a reply`,
  );
});

test("a free-text reply passes through unchanged", async () => {
  const { fake, delegate, reply } = await scenario([ASK, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "  cap at 5 per minute, keep the lockout  ")).split("\n")[0]).toMatch(
    /^OK /,
  );
  expect(fake.recorded.questionReplies[0].answers).toEqual([
    ["  cap at 5 per minute, keep the lockout  "],
  ]);
});

test("several questions at once: all shown numbered; a partial or unreadable reply FAILs and the job stays BLOCKED; one answer each resumes it", async () => {
  const both: Action = {
    questions: [
      { question: "Rate limit should:", options: ["run before lockout", "run after lockout"] },
      { question: "Store counters in:", options: ["memory", "redis"] },
    ],
  };
  const { fake, record, delegate, reply } = await scenario([both, ...edit(2, "done")]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe(
    [
      `BLOCKED ${job} step=1 files=0 +0/-0 turns=0 cost=$0.000`,
      "question 1: Rate limit should:",
      "options:",
      "  a) run before lockout",
      "  b) run after lockout",
      "question 2: Store counters in:",
      "options:",
      "  a) memory",
      "  b) redis",
      `log: .cheapag/jobs/${job}/`,
    ].join("\n"),
  );
  expect(record(job)).toMatchObject({
    status: "BLOCKED",
    question: null,
    questions: [
      { text: "Rate limit should:", answer: null },
      { text: "Store counters in:", answer: null },
    ],
  });
  for (const [answer, why] of [
    ["1b", "unanswered: question 2"],
    ["b", 'cannot read "b"'],
    ["1b, 2c", 'cannot read "2c"'],
    ["1b, 3a", 'cannot read "3a"'],
    ["1a, 1b, 2a", 'cannot read "1b"'],
    ["   ", "empty answer"],
  ])
    expect(await reply(job, answer), answer).toMatch(new RegExp(`^FAIL reason: ${why}`));
  expect(fake.recorded.questionReplies).toEqual([]); // nothing answered, nothing empty sent: still BLOCKED
  expect(record(job).status).toBe("BLOCKED");
  expect((await reply(job, "1b, 2: redis, with a 60s TTL")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([
    [["run after lockout"], ["redis, with a 60s TTL"]],
  ]);
  expect(record(job).questions.map((q: { answer: string }) => q.answer)).toEqual([
    "run after lockout",
    "redis, with a 60s TTL",
  ]);
});

test("one question also takes the numbered form; free text may span lines", async () => {
  const again: Action = { question: "Window length?", options: ["1 minute", "15 minutes"] };
  const { fake, delegate, reply } = await scenario([ASK, again, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "1c")).split("\n")[0]).toMatch(/^BLOCKED /);
  expect((await reply(job, "1: fifteen,\nrolling")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([
    [[OPTIONS[2]]],
    [["fifteen,\nrolling"]],
  ]);
});

test("several questions answered by letters only", async () => {
  const both: Action = {
    questions: [
      { question: "A?", options: ["x", "y"] },
      { question: "B?", options: ["p", "q"] },
    ],
  };
  const { fake, delegate, reply } = await scenario([both, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "2A,1b")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies[0].answers).toEqual([["y"], ["p"]]);
});

test("reply to an unknown job, or to a malformed id, is a clear FAIL", async () => {
  const { reply } = await scenario();
  expect(await reply("jzzzz", "a")).toBe(
    "FAIL reason: no job jzzzz; reply only to a BLOCKED job's id",
  );
  expect(await reply("../../etc", "a")).toBe(
    "FAIL reason: no job ../../etc; reply only to a BLOCKED job's id",
  );
});

test("a reply that cannot reach the paused session (OpenCode gone) is a FAIL that keeps the worktree, not a hang", async () => {
  const { repo, fake, record, delegate, reply } = await scenario([ASK, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  await fake.close();
  const text = await reply(job, "a");
  expect(text.split("\n")[0]).toMatch(new RegExp(`^FAIL ${job} `));
  expect(text).toContain("\nreason: worker error: could not answer the worker's question");
  expect(record(job)).toMatchObject({
    status: "FAIL",
    question: { answer: OPTIONS[0] },
    worktree: `.cheapag/worktrees/${job}`,
  });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
});

test("after a reply the job still self-fixes: verify fails, the fix in the same session passes", async () => {
  const { fake, record, delegate, reply } = await scenario(
    [ASK, ...edit(1, "first try")],
    edit(2, "fixed"),
  );
  const job = jobOf(await delegate());
  const text = await reply(job, "a");
  expect(text.split("\n")[0]).toMatch(/^OK .* tests=pass .* fix=1$/);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([
    fake.recorded.sessions[0].id,
    fake.recorded.sessions[0].id,
  ]);
  expect(record(job)).toMatchObject({ selfFix: 1, tried: ["fix 1: fixed → passed"] });
});

test("a worker that asks again after a reply is BLOCKED again; the next reply finishes it", async () => {
  const again: Action = { question: "Window length?", options: ["1 minute", "15 minutes"] };
  const { fake, delegate, reply } = await scenario([ASK, again, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  const second = await reply(job, "c");
  expect(second).toBe(
    [
      `BLOCKED ${job} step=1 files=0 +0/-0 turns=0 cost=$0.000`,
      "question: Window length?",
      "options:",
      "  a) 1 minute",
      "  b) 15 minutes",
      `log: .cheapag/jobs/${job}/`,
    ].join("\n"),
  );
  expect((await reply(job, "B")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([
    [[OPTIONS[2]]],
    [["15 minutes"]],
  ]);
});

test("a denied install becomes the dependency question, rendered in the documented form", async () => {
  const dep =
    'step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.';
  const { fake, delegate, reply } = await scenario([
    {
      tool: "bash",
      input: { command: "npm install zod" },
      error: "The user has specified a rule which prevents you from using this specific tool call.",
    },
    { question: dep, options: ["installed", "no"] },
    ...edit(2, "used zod"),
  ]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked.split("\n").slice(1, 4)).toEqual([
    `question: ${dep}`,
    "options:",
    "  a) installed",
  ]);
  expect((await reply(job, "installed")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies[0].answers).toEqual([["installed"]]);
});

test("jobs cancel ends a BLOCKED job: the question is rejected, the session aborted, and reply then refuses", async () => {
  const { repo, fake, record, delegate, reply, jobs } = await scenario([
    ASK,
    ...edit(2, "never reached"),
  ]);
  const job = jobOf(await delegate());
  const cancelled = await jobs("cancel", job);
  expect(cancelled.split("\n")[0]).toMatch(new RegExp(`^CANCELLED ${job} step=1 `));
  expect(cancelled).toContain("\nreason: cancelled on request\n");
  expect(fake.recorded.questionReplies).toEqual([expect.objectContaining({ rejected: true })]);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(record(job)).toMatchObject({ status: "CANCELLED", landed: false });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(await reply(job, "a")).toBe(
    `FAIL reason: job ${job} is CANCELLED, not BLOCKED; only a BLOCKED job takes a reply`,
  );
});

test("max_blocked_minutes: an unanswered job is CANCELLED, its question rejected and worktree kept; jobs list shows the wait", async () => {
  const { repo, fake, record, delegate, reply, call } = await scenario([
    ASK,
    ...edit(2, "never reached"),
  ]);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ limits: { max_blocked_minutes: 0.01 } }),
  ); // 600 ms
  const job = jobOf(await delegate());
  expect(await call("jobs", { action: "list" })).toMatch(
    new RegExp(`^BLOCKED ${job} step=1 .* waiting=0m$`),
  );
  await new Promise((r) => setTimeout(r, 1000));
  expect(record(job)).toMatchObject({
    status: "CANCELLED",
    landed: false,
    reason: "no reply within 0.01 min",
    worktree: `.cheapag/worktrees/${job}`,
  });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(fake.recorded.questionReplies).toEqual([expect.objectContaining({ rejected: true })]);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(await call("land", { job, action: "apply" })).toMatch(new RegExp(`^OK ${job} applied `)); // recoverable
  const list = await call("jobs", { action: "list" });
  expect(list).toMatch(new RegExp(`^CANCELLED ${job} step=1 `));
  expect(list).not.toContain("waiting="); // no wait shown once it ended
  expect(await reply(job, "a")).toBe(
    `FAIL reason: job ${job} is CANCELLED, not BLOCKED; only a BLOCKED job takes a reply`,
  );
});

test("max_blocked_minutes: a reply just before expiry resumes the job, and the expiry no longer applies", async () => {
  const { repo, delegate, reply } = await scenario([
    ASK,
    { wait: 1000 },
    ...edit(2, "answered in time"),
  ]);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ limits: { max_blocked_minutes: slow(0.02 * 1000) / 1000 } }),
  ); // 1.2 s (3.6 s on Windows)
  const job = jobOf(await delegate());
  await new Promise((r) => setTimeout(r, slow(800)));
  expect((await reply(job, "b")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `)); // ran past the original expiry
});

test("time spent BLOCKED does not count toward the minute cap", async () => {
  const { repo, delegate, reply } = await scenario([ASK, ...edit(2, "answered after a long wait")]);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ limits: { max_minutes: slow(0.01 * 1000) / 1000 } }),
  ); // 600 ms of working time (1.8 s on Windows)
  const job = jobOf(await delegate());
  await new Promise((r) => setTimeout(r, slow(1000))); // the developer takes a while to answer
  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `));
});

test("while a job holds OpenCode, a config change cannot reboot it: other calls FAIL clearly and the job lives on", async () => {
  const { repo, home, delegate, reply, call } = await scenario([
    ASK,
    ...edit(2, "answered after the refused reboot"),
  ]);
  const job = jobOf(await delegate());
  // a different model config (allowed by the developer) makes a different OpenCode config; with the job holding the server it must not reboot
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { implement: "opencode-go/qwen3.7-plus" } }),
  );
  allowRepo(repo.dir, homeEnv(home));
  writeFileSync(join(repo.dir, ".plan", "q.md"), PLAN);
  const refused = await call("delegate", { plan: ".plan/q.md", steps: "1" });
  expect(refused).toBe(
    "FAIL reason: the model configuration changed (consent or cheapag.json models) while jobs are running; retry once they finish",
  );
  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `));
});

// ticket 69: a command off the allow list pauses the job; the user's letter resumes it
const SED = {
  permission: "bash",
  patterns: ["sed -n 1,2p f"],
  command: "sed -n 1,2p f",
  description: "Peek at the start of f",
} as const;
const WHY = { text: "I need to look at the first lines of f before I edit." } as const;
const REFUSED = "the user refused this command; don't retry it or a variant";
const replies = (fake: {
  recorded: { permissionReplies: { reply: string; message?: string }[] };
}) => fake.recorded.permissionReplies.map((r) => [r.reply, r.message]);

test("a command off the list → BLOCKED permission block; a) allows it once and the job finishes in the same session", async () => {
  const { fake, record, delegate, reply } = await scenario([WHY, SED, ...edit(2, "done")]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe(
    [
      `BLOCKED ${job} step=1 permission`,
      "title: Peek at the start of f",
      "command: sed -n 1,2p f",
      "why: I need to look at the first lines of f before I edit.",
      "a) allow once",
      "c) refuse",
      "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.",
    ].join("\n"),
  );
  expect(record(job)).toMatchObject({
    status: "BLOCKED",
    permission: { command: "sed -n 1,2p f", prefix: "sed", always: false },
  });
  expect(await reply(job, "free text")).toBe("FAIL reason: answer a or c");
  expect((await reply(job, "a")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(replies(fake)).toEqual([["once", undefined]]);
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("a reasoning-only message gives that why; no description gives the step-based title; sed offers no b and rejects b", async () => {
  const sed = {
    permission: "bash",
    patterns: ["sed -n 1,3p README.md"],
    command: "sed -n 1,3p README.md",
  } as const;
  const { fake, delegate, reply } = await scenario([
    { reasoning: "Let me run the sed command and check README." },
    sed,
    ...edit(2, "done"),
  ]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe(
    [
      `BLOCKED ${job} step=1 permission`,
      "title: sed for step 1: limit login",
      "command: sed -n 1,3p README.md",
      "why: Let me run the sed command and check README.",
      "a) allow once",
      "c) refuse",
      "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.",
    ].join("\n"),
  );
  expect(await reply(job, "b")).toBe("FAIL reason: answer a or c");
  expect(fake.recorded.permissionReplies).toEqual([]);
  expect((await reply(job, "a")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(replies(fake)).toEqual([["once", undefined]]);
});

test("a non-writer command (rg) keeps option b", async () => {
  const rg = {
    permission: "bash",
    patterns: ["rg -n TODO src"],
    command: "rg -n TODO src",
  } as const;
  const { repo, delegate, reply } = await scenario([WHY, rg, ...edit(2, "done")]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toContain("title: rg for step 1: limit login");
  expect(blocked).toContain(
    "b) always allow `rg` in this repo (adds it to cheapag.json allow_commands)",
  );
  expect((await reply(job, "b")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(JSON.parse(readFileSync(join(repo.dir, "cheapag.json"), "utf8"))).toEqual({
    allow_commands: ["rg"],
  });
});

test("c) refuses with the no-retry message, and the same command asked again is rejected without a new block", async () => {
  const { fake, delegate, reply } = await scenario([WHY, SED, SED, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  const done = await reply(job, "c");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(replies(fake)).toEqual([
    ["reject", REFUSED],
    ["reject", REFUSED],
  ]);
});

test("b) saves the prefix to allow_commands (other keys kept); the next job's ruleset allows it; curl and writes are still never asked", async () => {
  const FILE = {
    permission: "bash",
    patterns: ["file README.md"],
    command: "file README.md",
    description: "Check the README type",
  } as const;
  const { repo, fake, delegate, reply } = await scenario(
    [
      WHY,
      FILE,
      { permission: "bash", patterns: ["cat a > b"], command: "cat a > b" },
      { permission: "bash", patterns: ["curl x"], command: "curl x" },
      ...edit(2, "done"),
    ],
    [...edit(2, "again")],
  );
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ test_cmd: "node check.mjs", allow_commands: ["echo hi"] }),
  );
  const job = jobOf(await delegate());
  expect((await reply(job, "b")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(JSON.parse(readFileSync(join(repo.dir, "cheapag.json"), "utf8"))).toEqual({
    test_cmd: "node check.mjs",
    allow_commands: ["echo hi", "file"],
  });
  expect(Object.keys(JSON.parse(readFileSync(join(repo.dir, "cheapag.json"), "utf8")))).toEqual([
    "test_cmd",
    "allow_commands",
  ]);
  // `cat a > b` and `curl x` were rejected with no block; only file asked
  expect(replies(fake).map(([r]) => r)).toEqual(["once", "reject", "reject"]);
  await delegate();
  const rules = fake.recorded.sessions[1].permission as {
    permission: string;
    pattern: string;
    action: string;
  }[];
  expect(rules).toContainEqual({ permission: "bash", pattern: "file *", action: "allow" });
});

test("b) creates cheapag.json with only allow_commands when the repo has none", async () => {
  const RG = {
    permission: "bash",
    patterns: ["rg -n TODO src"],
    command: "rg -n TODO src",
  } as const;
  const { repo, delegate, reply } = await scenario([WHY, RG, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  await reply(job, "b");
  expect(JSON.parse(readFileSync(join(repo.dir, "cheapag.json"), "utf8"))).toEqual({
    allow_commands: ["rg"],
  });
});

test("the 4th ask in a job is rejected, not shown", async () => {
  const ask = (n: number) =>
    ({ permission: "bash", patterns: [`sed -n ${n}p f`], command: `sed -n ${n}p f` }) as const;
  const { fake, delegate, reply } = await scenario([
    ask(1),
    ask(2),
    ask(3),
    ask(4),
    ...edit(2, "done"),
  ]);
  let out = await delegate();
  const job = jobOf(out);
  for (let n = 0; n < 3; n++) out = await reply(job, "a");
  expect(out.split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(replies(fake).map(([r]) => r)).toEqual(["once", "once", "once", "reject"]);
});

test("on_blocked_command deny: the worker's catch-all bash rule is deny, so nothing asks", async () => {
  const { repo, fake, delegate } = await scenario([...edit(2, "done")]);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ on_blocked_command: "deny" }));
  await delegate();
  const rules = fake.recorded.sessions[0].permission as {
    permission: string;
    pattern: string;
    action: string;
  }[];
  expect(rules.find((r) => r.permission === "bash" && r.pattern === "*")?.action).toBe("deny");
});

test("a permission block that offers b refuses any answer but a, b or c", async () => {
  const rg = {
    permission: "bash",
    patterns: ["rg -n TODO src"],
    command: "rg -n TODO src",
  } as const;
  const { fake, delegate, reply } = await scenario([WHY, rg, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect(await reply(job, "d")).toBe("FAIL reason: answer a, b or c");
  expect(fake.recorded.permissionReplies).toEqual([]);
  expect((await reply(job, "a")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} `));
  expect(replies(fake)).toEqual([["once", undefined]]);
});
