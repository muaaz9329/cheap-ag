import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";

const PLAN = "# Rate limit\n\n## 1 limit login\nfiles: src/hello.ts\ndo: export hello = 2\ndone-when: `node check.mjs` passes\n";
const CHECK = `import { readFileSync } from "node:fs";
if (readFileSync("src/hello.ts", "utf8").trim() === "export const hello = 2;") process.exit(0);
console.log("Error: hello is not 2");
process.exit(1);
`;
const OPTIONS = ["run before lockout (counts all attempts)", "run after lockout (counts only non-locked users)", "replace lockout entirely"];
const ASK: Action = { question: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:", options: OPTIONS };
const edit = (value: number, summary: string): Action[] => [
  { edit: "src/hello.ts", content: `export const hello = ${value};\n` }, { tool: "write" }, { usage: { cost: 0.001 } },
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
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const call = async (name: string, args: Record<string, string>) =>
    ((await server.client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  const record = (job: string) => JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  return {
    repo, fake, record,
    delegate: () => call("delegate", { plan: ".plan/p.md", steps: "1" }),
    reply: (job: string, answer: string) => call("reply", { job, answer }),
    jobs: (action: string, job: string) => call("jobs", { action, job }),
    call,
  };
}

const jobOf = (text: string) => text.match(/^\w+ (j[0-9a-z]{4}) /)![1];

test("an ambiguous step → BLOCKED with lettered options; a letter reply resumes the same session and lands OK", async () => {
  const { repo, fake, record, delegate, reply } = await scenario([{ tool: "read" }, ASK, ...edit(2, "rate limit runs after lockout")]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe([
    `BLOCKED ${job} step=1 files=0 +0/-0 turns=1 cost=$0.000`,
    "question: login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
    "options:",
    "  a) run before lockout (counts all attempts)",
    "  b) run after lockout (counts only non-locked users)",
    "  c) replace lockout entirely",
    `log: .cheapag/jobs/${job}/`,
  ].join("\n"));
  // paused, not rejected: the record says BLOCKED and the worktree is still there
  expect(fake.recorded.questionReplies).toEqual([]);
  expect(record(job)).toMatchObject({ status: "BLOCKED", landed: false, question: { text: ASK.question, options: OPTIONS, answer: null }, worktree: `.cheapag/worktrees/${job}` });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);

  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 files=1 \\+1/-1 tests=pass turns=3 cost=\\$0\\.001$`));
  expect(fake.recorded.questionReplies).toEqual([{ requestID: expect.any(String), answers: [[OPTIONS[1]]], rejected: false }]);
  // the same session carried on: one session, one prompt
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([fake.recorded.sessions[0].id]);
  expect(readFileSync(join(repo.dir, "src/hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  expect(record(job)).toMatchObject({ status: "OK", landed: true, sessionID: fake.recorded.sessions[0].id, question: { answer: OPTIONS[1] } });

  // it is no longer BLOCKED
  expect(await reply(job, "a")).toBe(`FAIL reason: job ${job} is OK, not BLOCKED; only a BLOCKED job takes a reply`);
});

test("a free-text reply passes through unchanged", async () => {
  const { fake, delegate, reply } = await scenario([ASK, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "  cap at 5 per minute, keep the lockout  ")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies[0].answers).toEqual([["  cap at 5 per minute, keep the lockout  "]]);
});

test("several questions at once: all shown numbered; a partial or unreadable reply FAILs and the job stays BLOCKED; one answer each resumes it", async () => {
  const both: Action = { questions: [{ question: "Rate limit should:", options: ["run before lockout", "run after lockout"] }, { question: "Store counters in:", options: ["memory", "redis"] }] };
  const { fake, record, delegate, reply } = await scenario([both, ...edit(2, "done")]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked).toBe([
    `BLOCKED ${job} step=1 files=0 +0/-0 turns=0 cost=$0.000`,
    "question 1: Rate limit should:", "options:", "  a) run before lockout", "  b) run after lockout",
    "question 2: Store counters in:", "options:", "  a) memory", "  b) redis",
    `log: .cheapag/jobs/${job}/`,
  ].join("\n"));
  expect(record(job)).toMatchObject({ status: "BLOCKED", question: null, questions: [{ text: "Rate limit should:", answer: null }, { text: "Store counters in:", answer: null }] });
  for (const [answer, why] of [
    ["1b", "unanswered: question 2"], ["b", 'cannot read "b"'], ["1b, 2c", 'cannot read "2c"'], ["1b, 3a", 'cannot read "3a"'], ["1a, 1b, 2a", 'cannot read "1b"'], ["   ", "empty answer"],
  ]) expect(await reply(job, answer), answer).toMatch(new RegExp(`^FAIL reason: ${why}`));
  expect(fake.recorded.questionReplies).toEqual([]); // nothing answered, nothing empty sent: still BLOCKED
  expect(record(job).status).toBe("BLOCKED");
  expect((await reply(job, "1b, 2: redis, with a 60s TTL")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([[["run after lockout"], ["redis, with a 60s TTL"]]]);
  expect(record(job).questions.map((q: { answer: string }) => q.answer)).toEqual(["run after lockout", "redis, with a 60s TTL"]);
});

test("one question also takes the numbered form; free text may span lines", async () => {
  const again: Action = { question: "Window length?", options: ["1 minute", "15 minutes"] };
  const { fake, delegate, reply } = await scenario([ASK, again, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "1c")).split("\n")[0]).toMatch(/^BLOCKED /);
  expect((await reply(job, "1: fifteen,\nrolling")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([[[OPTIONS[2]]], [["fifteen,\nrolling"]]]);
});

test("several questions answered by letters only", async () => {
  const both: Action = { questions: [{ question: "A?", options: ["x", "y"] }, { question: "B?", options: ["p", "q"] }] };
  const { fake, delegate, reply } = await scenario([both, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  expect((await reply(job, "2A,1b")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies[0].answers).toEqual([["y"], ["p"]]);
});

test("reply to an unknown job, or to a malformed id, is a clear FAIL", async () => {
  const { reply } = await scenario();
  expect(await reply("jzzzz", "a")).toBe("FAIL reason: no job jzzzz; reply only to a BLOCKED job's id");
  expect(await reply("../../etc", "a")).toBe("FAIL reason: no job ../../etc; reply only to a BLOCKED job's id");
});

test("a reply that cannot reach the paused session (OpenCode gone) is a FAIL that keeps the worktree, not a hang", async () => {
  const { repo, fake, record, delegate, reply } = await scenario([ASK, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  await fake.close();
  const text = await reply(job, "a");
  expect(text.split("\n")[0]).toMatch(new RegExp(`^FAIL ${job} `));
  expect(text).toContain("\nreason: worker error: could not answer the worker's question");
  expect(record(job)).toMatchObject({ status: "FAIL", question: { answer: OPTIONS[0] }, worktree: `.cheapag/worktrees/${job}` });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
});

test("after a reply the job still self-fixes: verify fails, the fix in the same session passes", async () => {
  const { fake, record, delegate, reply } = await scenario([ASK, ...edit(1, "first try")], edit(2, "fixed"));
  const job = jobOf(await delegate());
  const text = await reply(job, "a");
  expect(text.split("\n")[0]).toMatch(/^OK .* tests=pass .* fix=1$/);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([fake.recorded.sessions[0].id, fake.recorded.sessions[0].id]);
  expect(record(job)).toMatchObject({ selfFix: 1, tried: ["fix 1: fixed → passed"] });
});

test("a worker that asks again after a reply is BLOCKED again; the next reply finishes it", async () => {
  const again: Action = { question: "Window length?", options: ["1 minute", "15 minutes"] };
  const { fake, delegate, reply } = await scenario([ASK, again, ...edit(2, "done")]);
  const job = jobOf(await delegate());
  const second = await reply(job, "c");
  expect(second).toBe([`BLOCKED ${job} step=1 files=0 +0/-0 turns=0 cost=$0.000`, "question: Window length?", "options:", "  a) 1 minute", "  b) 15 minutes", `log: .cheapag/jobs/${job}/`].join("\n"));
  expect((await reply(job, "B")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies.map((r) => r.answers)).toEqual([[[OPTIONS[2]]], [["15 minutes"]]]);
});

test("a denied install becomes the dependency question, rendered in the documented form", async () => {
  const dep = 'step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.';
  const { fake, delegate, reply } = await scenario([
    { tool: "bash", input: { command: "npm install zod" }, error: "The user has specified a rule which prevents you from using this specific tool call." },
    { question: dep, options: ["installed", "no"] },
    ...edit(2, "used zod"),
  ]);
  const blocked = await delegate();
  const job = jobOf(blocked);
  expect(blocked.split("\n").slice(1, 4)).toEqual([`question: ${dep}`, "options:", "  a) installed"]);
  expect((await reply(job, "installed")).split("\n")[0]).toMatch(/^OK /);
  expect(fake.recorded.questionReplies[0].answers).toEqual([["installed"]]);
});

test("jobs cancel ends a BLOCKED job: the question is rejected, the session aborted, and reply then refuses", async () => {
  const { repo, fake, record, delegate, reply, jobs } = await scenario([ASK, ...edit(2, "never reached")]);
  const job = jobOf(await delegate());
  const cancelled = await jobs("cancel", job);
  expect(cancelled.split("\n")[0]).toMatch(new RegExp(`^CANCELLED ${job} step=1 `));
  expect(cancelled).toContain("\nreason: cancelled on request\n");
  expect(fake.recorded.questionReplies).toEqual([expect.objectContaining({ rejected: true })]);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(record(job)).toMatchObject({ status: "CANCELLED", landed: false });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(await reply(job, "a")).toBe(`FAIL reason: job ${job} is CANCELLED, not BLOCKED; only a BLOCKED job takes a reply`);
});

test("max_blocked_minutes: an unanswered job is CANCELLED, its question rejected and worktree kept; jobs list shows the wait", async () => {
  const { repo, fake, record, delegate, reply, call } = await scenario([ASK, ...edit(2, "never reached")]);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_blocked_minutes: 0.01 } })); // 600 ms
  const job = jobOf(await delegate());
  expect(await call("jobs", { action: "list" })).toMatch(new RegExp(`^BLOCKED ${job} step=1 .* waiting=0m$`));
  await new Promise((r) => setTimeout(r, 1000));
  expect(record(job)).toMatchObject({ status: "CANCELLED", landed: false, reason: "no reply within 0.01 min", worktree: `.cheapag/worktrees/${job}` });
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", job))).toBe(true);
  expect(fake.recorded.questionReplies).toEqual([expect.objectContaining({ rejected: true })]);
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(await call("land", { job, action: "apply" })).toMatch(new RegExp(`^OK ${job} applied `)); // recoverable
  const list = await call("jobs", { action: "list" });
  expect(list).toMatch(new RegExp(`^CANCELLED ${job} step=1 `));
  expect(list).not.toContain("waiting="); // no wait shown once it ended
  expect(await reply(job, "a")).toBe(`FAIL reason: job ${job} is CANCELLED, not BLOCKED; only a BLOCKED job takes a reply`);
});

test("max_blocked_minutes: a reply just before expiry resumes the job, and the expiry no longer applies", async () => {
  const { repo, delegate, reply } = await scenario([ASK, { wait: 1000 }, ...edit(2, "answered in time")]);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_blocked_minutes: 0.02 } })); // 1.2 s
  const job = jobOf(await delegate());
  await new Promise((r) => setTimeout(r, 800));
  expect((await reply(job, "b")).split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `)); // ran past the original expiry
});

test("time spent BLOCKED does not count toward the minute cap", async () => {
  const { repo, delegate, reply } = await scenario([ASK, ...edit(2, "answered after a long wait")]);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_minutes: 0.01 } })); // 600 ms of working time
  const job = jobOf(await delegate());
  await new Promise((r) => setTimeout(r, 1000)); // the developer takes a while to answer
  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `));
});

test("while a job holds OpenCode, a config change cannot reboot it: other calls FAIL clearly and the job lives on", async () => {
  const { repo, delegate, reply, call } = await scenario([ASK, ...edit(2, "answered after the refused reboot")]);
  const job = jobOf(await delegate());
  // a different model config makes a different OpenCode config; with the job holding the server it must not reboot
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { implement: "opencode-go/qwen3.7-plus" } }));
  writeFileSync(join(repo.dir, ".plan", "q.md"), PLAN);
  const refused = await call("delegate", { plan: ".plan/q.md", steps: "1" });
  expect(refused).toBe("FAIL reason: the model configuration changed (consent or cheapag.json models) while jobs are running; retry once they finish");
  const done = await reply(job, "b");
  expect(done.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `));
});
