import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import * as consent from "../src/consent.js";
import * as opencode from "../src/opencode.js";
import * as routing from "../src/routing.js";
import * as worker from "../src/worker.js";
import * as workspace from "../src/workspace.js";
import {
  BRIEF_FORMAT,
  REPRO_RULE,
  parseAnswer,
  refTokens,
  research as runResearch,
  verifyRepro,
} from "../src/research.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { callText, removeDir, slow, startServer, tempRepo, type Logins } from "./harness.js";

/** Research through the MCP seam, with the fake OpenCode. Read-only enforcement itself: research-permissions.test.ts. */

const AUTH = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";

/** A repo with an uncommitted src/auth.ts and README edit, a fake worker, and a server (pre-approved unless `allow` is null). */
async function scenario(opts: { allow?: string[] | null; logins?: Logins } = {}) {
  const repo = tempRepo("dirty");
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "auth.ts"), AUTH);
  writeFileSync(join(repo.dir, "src", "app.ts"), "export {};\n");
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: opts.logins ?? { "opencode-go": "k" },
    allow: opts.allow === null ? undefined : (opts.allow ?? []),
  });
  onTestFinished(server.close);
  const research = (args: Record<string, unknown>) => callText(server.client, "research", args);
  return { repo, fake, server, research };
}

const block = (fields: string) => ({
  text: `Found it.\n\`\`\`cheapag-research\n${fields}\n\`\`\``,
});
/** The repro rule, then the word cap, then the brief format: every research prompt (src/research.ts). */
const prompt = (head: string, words = 200) =>
  `${head}\n${REPRO_RULE}\nAnswer in at most ${words} words.\n${BRIEF_FORMAT}`;

const idOf = (text: string) => text.match(/^\w+ (r[0-9a-z]{4}) /)![1];

test.each([
  ["FAIL", "release"],
  ["FAIL", "remove"],
  ["ANSWER", "release"],
  ["ANSWER", "remove"],
] as const)("%s terminal records survive EBUSY during worktree %s", async (status, phase) => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  vi.spyOn(consent, "consentGate").mockReturnValue({ route: routing.fullRoute("opencode-go") });
  vi.spyOn(routing, "recordSpend").mockImplementation(() => {});
  const releaseHold = vi.fn();
  vi.spyOn(opencode, "holdOpencode").mockReturnValue(releaseHold);
  vi.spyOn(worker, "openSession").mockResolvedValue({
    sessionID: "research-fault",
    rotate: async () => false,
    run: async () =>
      status === "FAIL"
        ? { text: "", error: "API rejected request (400)" }
        : block("status: answer\nconfidence: high\nnotes: useful answer"),
    totals: () => ({
      sessionID: "research-fault",
      turns: 0,
      calls: 0,
      usage: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      rejections: [],
      spend: {},
    }),
  });
  let id = "";
  const persistedBeforeCleanup: boolean[] = [];
  const observe = (path: string) => {
    id = path.split(/[\\/]/).at(-1)!;
    const dir = join(repo.dir, ".cheapag", "jobs", id);
    persistedBeforeCleanup.push(
      existsSync(join(dir, "research.json")) && existsSync(join(dir, "result.txt")),
    );
  };
  const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  const releaseDirectory = vi.spyOn(worker, "releaseDirectory").mockImplementation(async (path) => {
    observe(path);
    if (phase === "release") throw busy;
  });
  const removeWorktree = vi.spyOn(workspace, "removeWorktree").mockImplementation((_root, tree) => {
    observe(tree.path);
    throw busy;
  });
  const text = await runResearch(
    { question: "where is the code?", root: repo.dir },
    {
      provider: { provider: "opencode-go", via: "login" },
      opencode: async () => ({ url: "http://unused.invalid", password: "unused", version: "test" }),
      progress: () => {},
    },
  );
  const dir = join(repo.dir, ".cheapag", "jobs", id);
  const record = JSON.parse(readFileSync(join(dir, "research.json"), "utf8"));
  expect(record).toMatchObject({
    status,
    cleanupError: busy.message,
    worktree: `.cheapag/worktrees/${id}`,
  });
  if (status === "FAIL") {
    expect(record.reason).toBe("worker error: API rejected request (400)");
    expect(text).toContain("reason: worker error: API rejected request (400)");
  } else {
    expect(record.answer).toBe("useful answer");
    expect(record.reason).toBeUndefined();
  }
  expect(persistedBeforeCleanup).toEqual(phase === "release" ? [true] : [true, true]);
  expect(text).toContain(`worktree: .cheapag/worktrees/${id}/`);
  expect(text).toContain(`cleanup error: ${busy.message}`);
  expect(readFileSync(join(dir, "result.txt"), "utf8")).toBe(text + "\n");
  expect(existsSync(join(repo.dir, record.worktree))).toBe(true);
  expect(releaseDirectory).toHaveBeenCalledTimes(1);
  expect(removeWorktree).toHaveBeenCalledTimes(phase === "remove" ? 1 : 0);
  expect(releaseHold).toHaveBeenCalledTimes(1);
});

test("the ref parser accepts Windows drive-letter and backslash paths, and POSIX ones", () => {
  expect(refTokens("C:\\x\\src\\app.ts:1 and src/app.ts:2-3")).toEqual([
    { path: "C:\\x\\src\\app.ts", from: "1", to: undefined },
    { path: "src/app.ts", from: "2", to: "3" },
  ]);
});

test("an unapproved repo gets CONSENT, naming the research model, before anything is created or sent", async () => {
  const { repo, fake, research } = await scenario({ allow: null });
  const text = await research({ question: "where is auth?" });
  expect(text).toMatch(/^CONSENT repo=/);
  expect(text).toContain(
    "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
  );
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
  expect(fake.recorded.requests).toEqual([]);
});

test("answers from the main checkout, uncommitted work included, with validated refs and confidence; the tree is untouched", async () => {
  const { repo, fake, server, research } = await scenario();
  // everything but Cheap Agent's own state
  const tree = () =>
    repo
      .git("status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter((l) => !l.includes(".cheapag/"))
      .join("\n");
  const before = tree();
  fake.script(
    { tool: "read", input: { filePath: join(repo.dir, "src", "auth.ts") } },
    { tool: "read", input: { filePath: join(repo.dir, "src", "auth.ts") } },
    { tool: "read", input: { filePath: join(repo.dir, "README.md") } },
    { tool: "grep", input: { pattern: "verify" } },
    { usage: { cost: 0.003, input: 2000, output: 100 } },
    block(
      [
        "status: answer",
        "confidence: High",
        // kept: in range, absolute path made relative; dropped: past the end, missing file, outside the repo
        `refs: src/auth.ts:18-22, ${join(repo.dir, "src", "app.ts")}:1, src/auth.ts:39-41, src/nope.ts:3, ../outside.ts:1`,
        "answer:",
        "JWT is validated in src/auth.ts:18-22,",
        "called from src/app.ts:1.",
      ].join("\n"),
    ),
  );
  const text = await research({ question: "where is JWT validated?" });
  const id = idOf(text);
  expect(text).toBe(
    [
      `ANSWER ${id} files_read=2 turns=4 cost=$0.003`,
      "files: src/auth.ts:18-22, src/app.ts:1",
      "notes:",
      "JWT is validated in src/auth.ts:18-22,",
      "called from src/app.ts:1.",
      "confidence: high",
      `log: .cheapag/jobs/${id}/`,
    ].join("\n"),
  );
  // an answer's event log is gzipped; an UNSURE one stays plain (checked in its own test)
  const logDir = join(repo.dir, ".cheapag", "jobs", id);
  expect(existsSync(join(logDir, "events.jsonl"))).toBe(false);
  for (const line of gunzipSync(readFileSync(join(logDir, "events.jsonl.gz")))
    .toString("utf8")
    .trim()
    .split("\n"))
    JSON.parse(line);

  // its own agent and ruleset (read, search, test commands; never edit), in a throwaway worktree, on the research model
  const [session] = fake.recorded.sessions;
  expect(session).toMatchObject({
    directory: join(repo.dir, ".cheapag", "worktrees", id),
    agent: "cheapag-research",
    model: { providerID: "opencode-go", id: "qwen3.8-flash" },
  });
  expect(session.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
  expect(session.permission).toContainEqual({
    permission: "bash",
    pattern: "pytest *",
    action: "allow",
  });
  expect(fake.recorded.prompts[0].parts).toEqual([
    { type: "text", text: prompt("Question: where is JWT validated?") },
  ]);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", id))).toBe(false); // removed once answered
  expect(tree()).toBe(before);

  // the record and the block are logged; `jobs list` does not mistake research for a job
  const record = JSON.parse(
    readFileSync(join(repo.dir, ".cheapag", "jobs", id, "research.json"), "utf8"),
  );
  expect(record).toMatchObject({
    format: "cheapag/1",
    job: id,
    kind: "research",
    status: "ANSWER",
    unlanded: [],
    models: { requested: "opencode-go/qwen3.8-flash", final: "opencode-go/qwen3.8-flash" },
  });
  expect(readFileSync(join(repo.dir, ".cheapag", "jobs", id, "result.txt"), "utf8")).toBe(
    text + "\n",
  );
  expect(await callText(server.client, "jobs", { action: "list" })).toBe("no jobs yet");
});

test("max_words caps the answer (default 200, at most 600) and long prose is wrapped, not elided", async () => {
  const { fake, research } = await scenario();
  const long = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
  fake.script(block(`status: answer\nconfidence: medium\nanswer: ${long}`));
  const capped = await research({ question: "q", max_words: 5 });
  expect(capped.split("\n").slice(1, 3)).toEqual(["notes:", "w0 w1 w2 w3 w4 …"]);
  expect(fake.recorded.prompts[0].parts).toEqual([
    { type: "text", text: prompt("Question: q", 5) },
  ]);

  fake.script(block(`status: answer\nconfidence: medium\nanswer: ${long}`));
  const most = await research({ question: "q", max_words: 5000 });
  expect(fake.recorded.prompts[1].parts).toEqual([
    { type: "text", text: prompt("Question: q", 600) },
  ]);
  const prose = most.split("\n").slice(2, -2).join(" ");
  expect(prose).toBe(`${long.split(" ").slice(0, 600).join(" ")} …`);
  for (const line of most.split("\n")) expect(line.length).toBeLessThanOrEqual(200);
});

test("paths scope the search: the prompt names them, refs outside are dropped, and bad paths FAIL before anything runs", async () => {
  const { fake, research } = await scenario();
  fake.script(
    block("status: answer\nconfidence: high\nrefs: src/auth.ts:1, README.md:1\nanswer: see auth"),
  );
  const text = await research({ question: "q", paths: " src , src/app.ts" });
  expect(fake.recorded.prompts[0].parts).toEqual([
    {
      type: "text",
      text: prompt("Question: q\nScope: look only under src, src/app.ts; cite only files there."),
    },
  ]);
  expect(text).toContain("\nfiles: src/auth.ts:1\n");

  expect(await research({ question: "q", paths: "../elsewhere" })).toBe(
    "FAIL reason: path ../elsewhere must be inside the repository, relative to its root",
  );
  expect(await research({ question: "q", paths: "/etc" })).toBe(
    "FAIL reason: path /etc must be inside the repository, relative to its root",
  );
  expect(await research({ question: "q", paths: "lib" })).toBe("FAIL reason: path lib not found");
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("a path that does not exist but whose basename is unique is resolved by basename with a note; several are ambiguous", async () => {
  const { repo, fake, research } = await scenario();
  mkdirSync(join(repo.dir, "a"));
  mkdirSync(join(repo.dir, "b"));
  writeFileSync(join(repo.dir, "a", "util.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "b", "util.ts"), "export {};\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "two utils");

  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  const text = await research({ question: "q", paths: "nope/README.md" });
  expect(text).toContain("nope/README.md resolved to README.md");
  expect(fake.recorded.prompts[0].parts).toEqual([
    {
      type: "text",
      text: prompt("Question: q\nScope: look only under README.md; cite only files there."),
    },
  ]);

  expect(await research({ question: "q", paths: "x/util.ts" })).toBe(
    "FAIL reason: path x/util.ts not found; did you mean: a/util.ts, b/util.ts",
  );
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("UNSURE: when the worker says so, and (low confidence) when it answers without the block; FAIL when it says nothing", async () => {
  const { fake, research } = await scenario();
  fake.script(block("status: unsure\nconfidence: low\nanswer: no refresh endpoint found"));
  expect(await research({ question: "q" })).toMatch(
    /^UNSURE r\w{4} .*\nnotes:\nno refresh endpoint found\nconfidence: low\n/,
  );
  fake.script({ text: "It is in src/auth.ts:3 I think." });
  expect(await research({ question: "q" })).toMatch(
    /^UNSURE r\w{4} .*\nfiles: src\/auth.ts:3\nnotes:\nIt is in src\/auth.ts:3 I think.\nconfidence: low\n/,
  );
  fake.script();
  expect(await research({ question: "q" })).toMatch(
    /^FAIL r\w{4} files_read=0 turns=0 cost=\$0.000\nreason: the research worker gave no answer\nlog: /,
  );
  fake.script({ error: { name: "ProviderAuthError", message: "bad key" } });
  expect(await research({ question: "q" })).toMatch(/\nreason: worker error: bad key\n/);
});

test("a Go limit on the research model falls back to DeepSeek Flash in the same session; limits on both → BUDGET", async () => {
  const { fake, research } = await scenario();
  fake.script(
    { usage: { cost: 0.001 } },
    { retry: { reason: "account_rate_limit", message: "Resets in 2h" } },
  );
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  const text = await research({ question: "q" });
  expect(text).toMatch(
    /^ANSWER r\w{4} files_read=0 turns=0 cost=\$0.001 model=opencode-go\/deepseek-v4.1-flash\nnotes:\nok\n/,
  );
  // the shared routing machinery: one session, the fallback named on the continued prompt (src/routing.ts)
  expect(fake.recorded.sessions.map((s) => s.model?.id)).toEqual(["qwen3.8-flash"]);
  expect(fake.recorded.prompts.map((p) => p.model?.modelID)).toEqual([
    undefined,
    "deepseek-v4.1-flash",
  ]);
  expect(fake.recorded.aborts).toEqual([fake.recorded.sessions[0].id]);

  fake.script({ retry: { reason: "account_rate_limit", message: "Resets in 2h" } });
  fake.script({ retry: { reason: "free_tier_limit", message: "Resets in 5h" } });
  const capped = await research({ question: "q" });
  expect(capped).toMatch(/^BUDGET r\w{4} .* model=opencode-go\/deepseek-v4.1-flash\nreason: /);
  expect(capped).toContain("qwen3.8-flash"); // the reason names every capped model (src/routing.ts exhausted())
});

test("the allowlist applies: without the research model, research runs on the allowed implement model", async () => {
  const { fake, research } = await scenario({
    allow: ["--models", "opencode-go/deepseek-v4.1-flash"],
  });
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  expect(await research({ question: "q" })).toMatch(
    /^ANSWER r\w{4} files_read=0 turns=0 cost=\$0.000\nnotes:\nok\n/,
  );
  expect(fake.recorded.sessions[0].model).toEqual({
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
  });
});

test("note lists unlanded jobs: in flight, or unlanded changes in a worktree that still exists", async () => {
  const { repo, fake, research } = await scenario();
  const job = (id: string, startedAt: string, fields: Record<string, unknown>) => {
    mkdirSync(join(repo.dir, ".cheapag", "jobs", id), { recursive: true });
    writeFileSync(
      join(repo.dir, ".cheapag", "jobs", id, "result.json"),
      JSON.stringify({
        job: id,
        landed: false,
        changed: [],
        worktree: null,
        timing: { startedAt },
        ...fields,
      }),
    );
  };
  mkdirSync(join(repo.dir, ".cheapag", "worktrees", "j0002"), { recursive: true });
  job("j0002", "2026-10-02", {
    status: "FAIL",
    worktree: ".cheapag/worktrees/j0002",
    changed: [{ status: "M", path: "README.md", add: 1, del: 0 }],
  });
  job("j0001", "2026-10-01", { status: "BLOCKED" });
  job("j0003", "2026-10-03", { status: "OK", landed: true });
  job("j0004", "2026-10-04", { status: "FAIL", worktree: ".cheapag/worktrees/j0004" }); // changed nothing
  job("j0005", "2026-10-05", {
    status: "PARTIAL",
    worktree: ".cheapag/worktrees/j0005",
    changed: [{ status: "A", path: "x", add: 1, del: 0 }],
  }); // worktree discarded
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  expect(await research({ question: "q" })).toContain(
    "\nnote: 2 jobs not yet landed (j0001, j0002); their changes are not visible to research\n",
  );
});

test(
  "runs while a delegate job is running, and notes that job as not yet landed",
  async () => {
    const { repo, fake, server, research } = await scenario();
    writeFileSync(
      join(repo.dir, "plan.md"),
      "# P\n## 1 hello\nfiles: hello.txt\ndo: write hello.txt\ndone-when: hello exists\n",
    );
    fake.script(
      { edit: "hello.txt", content: "hi\n" },
      { tool: "write" },
      { wait: 60_000 },
      { finish: { summary: "wrote hello", risks: [], review: [], missing: [] } },
    );
    const delegated = callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
    await vi.waitFor(() => expect(fake.recorded.prompts).toHaveLength(1), { timeout: 10_000 });
    fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
    const text = await research({ question: "q" });
    expect(text).toMatch(/^ANSWER r\w{4} /);
    const job = text.match(/note: 1 job not yet landed \((j\w{4})\)/)![1];
    expect(await callText(server.client, "jobs", { action: "cancel", job })).toMatch(/^CANCELLED /);
    expect(await delegated).toMatch(/^CANCELLED /);
  },
  slow(30_000),
);

test("a scout brief: ranked files, a reproduction the worker ran, dead ends, notes", async () => {
  const { fake, research } = await scenario();
  fake.script(
    {
      tool: "bash",
      input: { command: "pytest tests/test_auth.py -k expiry", description: "repro" },
      output: "1 failed",
    },
    block(
      [
        "status: answer",
        "confidence: high",
        "files: src/auth.ts:18-22, src/app.ts:1",
        "repro: `pytest tests/test_auth.py -k expiry` → 1 failed: TokenExpiredError not caught",
        "dead ends: the middleware order is fine",
        "notes: the expiry check runs after decoding",
      ].join("\n"),
    ),
  );
  const text = await research({ question: "why does the expiry test fail?" });
  expect(text.split("\n").slice(1, 6)).toEqual([
    "files: src/auth.ts:18-22, src/app.ts:1",
    "repro: `pytest tests/test_auth.py -k expiry` → 1 failed: TokenExpiredError not caught",
    "dead ends: the middleware order is fine",
    "notes:",
    "the expiry check runs after decoding",
  ]);
  expect(text).toContain("\nconfidence: high\n");
});

test("a claimed reproduction the worker never ran is marked unverified and drops confidence to low", async () => {
  const { fake, research } = await scenario();
  fake.script(
    block(
      "status: answer\nconfidence: high\nrepro: `pytest tests/test_auth.py` → 1 failed\ndead ends: none\nnotes: it fails",
    ),
  );
  const text = await research({ question: "why does it fail?" });
  expect(text).toContain("\nrepro: unverified (not run): `pytest tests/test_auth.py` → 1 failed\n");
  expect(text).not.toContain("dead ends:"); // "none" is not shown
  expect(text).toContain("\nconfidence: low\n");
  fake.script(block("status: answer\nconfidence: medium\nrepro: not attempted\nnotes: read only"));
  expect(await research({ question: "where is it?" })).toMatch(
    /\nrepro: not attempted\n[\s\S]*\nconfidence: medium\n/,
  );
});

test("a turn cap recovers what the worker read: one no-tool prompt, rendered as ANSWER status=partial; other failures stay FAIL", async () => {
  const { repo, fake, research } = await scenario();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_turns: 2 } }));
  fake.script({ tool: "read" }, { tool: "grep" });
  fake.script(
    block(
      "status: partial\nconfidence: medium\nrefs: src/auth.ts:18-22\nanswer:\nSo far: validation looks to be in src/auth.ts:18-22.",
    ),
  );
  const text = await research({ question: "where is JWT validated?" });
  expect(text).toMatch(
    /^ANSWER r\w{4} files_read=1 turns=2 cost=\$0.000 status=partial\nfiles: src\/auth.ts:18-22\nnotes:\nSo far: /,
  );
  expect(text).toContain("\nreason: turn cap (2) reached\n");
  expect(fake.recorded.prompts[1].parts).toMatchObject([
    { text: expect.stringContaining("status: partial") },
  ]);
  expect(fake.recorded.aborts).toEqual([]); // an aborted session answers "" (field report round 2)

  // a partial reply that does not parse is the old FAIL
  fake.script({ tool: "read" }, { tool: "grep" });
  expect(await research({ question: "q" })).toMatch(
    /^FAIL r\w{4} .*\nreason: turn cap \(2\) reached\n/,
  );
});

test("a cost cap still aborts the session (only the turn cap leaves it live for the partial prompt)", async () => {
  const { repo, fake, research } = await scenario();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_cost_usd: 0.01 } }));
  fake.script({ usage: { cost: 0.02 } }, { wait: 60_000 });
  expect(await research({ question: "q" })).toMatch(
    /^BUDGET r\w{4} .*\nreason: job cap \(\$0.01\) reached\n/,
  );
  expect(fake.recorded.aborts).toHaveLength(1);
  expect(fake.recorded.prompts).toHaveLength(1); // no partial prompt
});

test("a repository with no commits yet is refused before anything runs", async () => {
  // tempRepo always commits, so build the bare-init repo inline
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-test-")));
  onTestFinished(() => removeDir(dir));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# fixture\n"); // files, but no commit
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({
    cwd: dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: [],
  });
  onTestFinished(server.close);
  const text = await callText(server.client, "research", { question: "where is auth?" });
  expect(text).toBe(
    'FAIL reason: this repository has no commits yet, and Cheap Agent starts each job from the last commit. Make a first commit, then research again: git add -A && git commit -m "start"',
  );
  expect(fake.recorded.sessions).toEqual([]);
  expect(existsSync(join(dir, ".cheapag", "jobs"))).toBe(false);
});

/** In-process research with the consent gate and OpenCode stubbed; `session` stands in for the worker session. */
async function stubbed(
  repo: { dir: string },
  session: (
    opts: Parameters<typeof worker.openSession>[0],
  ) => Partial<worker.Session> | Promise<never>,
  progress: (turns: number, message: string) => void = () => {},
) {
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  vi.spyOn(consent, "consentGate").mockReturnValue({ route: routing.fullRoute("opencode-go") });
  vi.spyOn(routing, "recordSpend").mockImplementation(() => {});
  const releaseHold = vi.fn();
  vi.spyOn(opencode, "holdOpencode").mockReturnValue(releaseHold);
  const totals = () => ({
    sessionID: "s",
    turns: 0,
    calls: 0,
    usage: {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    rejections: [],
    spend: {},
  });
  vi.spyOn(worker, "openSession").mockImplementation(
    async (opts) =>
      ({
        sessionID: "s",
        rotate: async () => false,
        totals,
        ...(await session(opts)),
      }) as worker.Session,
  );
  const text = await runResearch(
    { question: "q", root: repo.dir },
    {
      provider: { provider: "opencode-go", via: "login" },
      opencode: async () => ({ url: "http://unused.invalid", password: "unused", version: "test" }),
      progress,
    },
  );
  return { text, releaseHold };
}

test("a damaged cheapag.json fails research with the config error, before any record is made", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "cheapag.json"), "{ not json");
  const { text } = await stubbed(repo, () => ({}));
  expect(text).toMatch(/^FAIL reason: .*cheapag\.json is not valid JSON: /);
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
  expect(worker.openSession).not.toHaveBeenCalled();
});

test("a session that cannot open is a FAIL naming the error, and the OpenCode hold is released", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { text, releaseHold } = await stubbed(repo, () =>
    Promise.reject(new Error("OpenCode refused the session")),
  );
  expect(text).toMatch(/^FAIL r\w{4} /);
  expect(text).toContain("OpenCode refused the session");
  expect(releaseHold).toHaveBeenCalledTimes(1);
});

test("a turn cap whose partial prompt throws stays a FAIL with the cap as the reason", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_turns: 1 } }));
  const prompts: string[] = [];
  const { text } = await stubbed(repo, (opts) => ({
    run: async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length > 1) throw new Error("session gone");
      opts.onEvent?.(
        {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { filePath: "a.ts" } },
            },
          },
        } as never,
        1,
      );
      return { text: "" };
    },
  }));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("status: partial");
  expect(text).toMatch(/^FAIL r\w{4} .*\nreason: turn cap \(1\) reached\n/);
});

/** A tool part event as OpenCode streams it, for a stubbed session's onEvent. */
const toolEvent = (tool: string, status: string, input: Record<string, unknown> = {}) =>
  ({
    type: "message.part.updated",
    properties: { part: { type: "tool", tool, state: { status, input } } },
  }) as never;

/** The id from a research block, then the research.json it left. */
function recordOf(repo: { dir: string }, text: string) {
  const id = idOf(text);
  const dir = join(repo.dir, ".cheapag", "jobs", id);
  return { id, dir, record: JSON.parse(readFileSync(join(dir, "research.json"), "utf8")) };
}

test("each finished or failed tool call is progress and every event is logged redacted; reads count per file, and bash commands back a repro", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const progress: [number, string][] = [];
  const events = [
    toolEvent("read", "running", { filePath: "a.ts" }),
    toolEvent("read", "completed", { filePath: "a.ts" }),
    toolEvent("read", "completed", { filePath: "a.ts" }),
    toolEvent("read", "completed", { filePath: "b.ts" }),
    toolEvent("grep", "error", { pattern: "x" }),
    toolEvent("bash", "completed", { command: "npm  test sk-0123456789abcdefABCD" }),
    toolEvent("bash", "running", { command: "pytest" }),
  ];
  const { text } = await stubbed(
    repo,
    (opts) => ({
      run: async () => {
        events.forEach((event, index) => opts.onEvent(event, Math.ceil(index / 2)));
        return block("status: answer\nconfidence: high\nrepro: `npm test` → 1 failed\nnotes: ok");
      },
    }),
    (turns, message) => progress.push([turns, message]),
  );
  expect(progress).toEqual([
    [1, "turn 1: read"],
    [1, "turn 1: read"],
    [2, "turn 2: read"],
    [2, "turn 2: grep"],
    [3, "turn 3: bash"],
  ]);
  expect(text).toMatch(/^ANSWER r\w{4} files_read=2 turns=0 cost=\$0.000\n/);
  expect(text).toContain("\nrepro: `npm test` → 1 failed\n");
  expect(text).toContain("\nconfidence: high\n");
  const { dir } = recordOf(repo, text);
  const logged = gunzipSync(readFileSync(join(dir, "events.jsonl.gz"))).toString("utf8");
  expect(logged).toBe(
    events.map((event) => JSON.stringify(event).replace(/sk-\w+/, "[redacted]") + "\n").join(""),
  );
});

test("an UNSURE answer leaves its event log plain", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { text } = await stubbed(repo, (opts) => ({
    run: async () => {
      opts.onEvent(toolEvent("grep", "completed"), 1);
      return { text: "not sure" };
    },
  }));
  const { dir } = recordOf(repo, text);
  expect(text).toMatch(/^UNSURE /);
  expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe(
    JSON.stringify(toolEvent("grep", "completed")) + "\n",
  );
  expect(existsSync(join(dir, "events.jsonl.gz"))).toBe(false);
});

test("the minute cap aborts the session and FAILs with the cap as the reason", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_minutes: 0.001 } }));
  const { text } = await stubbed(repo, (opts) => ({
    run: () =>
      new Promise((resolve) =>
        opts.signal!.addEventListener("abort", () => resolve({ text: "", error: "aborted" })),
      ),
  }));
  expect(text).toMatch(/^FAIL r\w{4} .*\nreason: minute cap \(0\.001 min\) reached\n/);
});

test.each([
  [
    { provider: "m is failing", budget: "Go cap", error: "boom" },
    "FAIL",
    "provider down: m is failing",
  ],
  [{ budget: "Go cap", error: "boom" }, "BUDGET", "Go cap"],
  [{ budget: "", error: "boom" }, "FAIL", ""],
  [{ provider: "", error: "boom" }, "FAIL", "worker error: boom"],
  [{ text: "```cheapag-research\nnotes: found\n```", error: "late" }, "FAIL", "worker error: late"],
  [{ text: "```cheapag-research\nnotes: found\n```", budget: "" }, "ANSWER", ""],
])("a worker result %j is %s with the reason %j", async (result, status, reason) => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  vi.spyOn(routing, "runRouted").mockResolvedValue({ text: "", ...result });
  const { text } = await stubbed(repo, () => ({}));
  const { record } = recordOf(repo, text);
  expect(record.status).toBe(status);
  expect(record.reason).toBe(reason);
});

test("usage comes from the session totals, and a failing spend ledger never fails the answer", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const spend = { "opencode-go": 0.25 };
  const { text } = await stubbed(repo, () => {
    vi.mocked(routing.recordSpend).mockImplementation(() => {
      throw new Error("ledger locked");
    });
    return {
      run: async () => block("status: answer\nconfidence: high\nnotes: fine"),
      totals: () => ({
        sessionID: "s",
        turns: 3,
        calls: 5,
        usage: {
          costUsd: 0.25,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        rejections: [],
        spend,
      }),
    };
  });
  expect(text).toMatch(/^ANSWER r\w{4} files_read=0 turns=3 cost=\$0.250\nnotes:\nfine\n/);
  expect(recordOf(repo, text).record.usage).toEqual({ turns: 3, calls: 5, costUsd: 0.25 });
  expect(routing.recordSpend).toHaveBeenCalledWith(spend);
});

test("request.json and research.json keep their fields in order", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { text } = await stubbed(repo, () => ({
    run: async () =>
      block(
        "status: answer\nconfidence: high\nrepro: not attempted\ndead ends: the cache\nnotes: fine",
      ),
  }));
  const { id, dir, record } = recordOf(repo, text);
  const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
  expect(Object.keys(request)).toEqual([
    "question",
    "root",
    "scope",
    "maxWords",
    "models",
    "startedAt",
  ]);
  expect(request).toMatchObject({ question: "q", root: repo.dir, scope: [], maxWords: 200 });
  expect(request.models).toEqual(["opencode-go/qwen3.8-flash", "opencode-go/deepseek-v4.1-flash"]);
  expect(readFileSync(join(dir, "request.json"), "utf8")).toBe(
    JSON.stringify(request, null, 2) + "\n",
  );
  expect(Object.keys(record)).toEqual([
    "format",
    "job",
    "kind",
    "provider",
    "question",
    "scope",
    "status",
    "answer",
    "refs",
    "confidence",
    "repro",
    "deadEnds",
    "filesRead",
    "unlanded",
    "models",
    "usage",
    "timing",
  ]);
  expect(record).toMatchObject({
    format: "cheapag/1",
    job: id,
    kind: "research",
    provider: "opencode-go",
    question: "q",
    status: "ANSWER",
    answer: "fine",
    repro: "not attempted",
    deadEnds: "the cache",
    filesRead: 0,
    unlanded: [],
    models: { requested: "opencode-go/qwen3.8-flash", final: "opencode-go/qwen3.8-flash" },
    usage: { turns: 0, calls: 0, costUsd: 0 },
  });
  expect(Object.keys(record.timing)).toEqual(["startedAt", "endedAt", "ms"]);
  expect(record.timing.startedAt).toBe(request.startedAt);
});

test("a FAIL record has an empty answer and no refs, then its reason", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { text } = await stubbed(repo, () => ({ run: async () => ({ text: "" }) }));
  const { record } = recordOf(repo, text);
  expect(Object.keys(record).slice(6, 10)).toEqual(["status", "answer", "refs", "reason"]);
  expect(record).toMatchObject({
    status: "FAIL",
    answer: "",
    refs: [],
    reason: "the research worker gave no answer",
  });
});

test.each([[{ error: "boom" }], [{ interrupted: true }]])(
  "the turn-cap prompt runs once more without tools on its own timeout; a reply with %j recovers nothing",
  async (reply) => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_turns: 1 } }));
    const calls: unknown[][] = [];
    const { text } = await stubbed(repo, (opts) => ({
      run: async (...args: unknown[]) => {
        calls.push(args);
        if (calls.length > 1)
          return { ...block("status: partial\nconfidence: high\nnotes: so far"), ...reply };
        opts.onEvent(toolEvent("read", "completed", { filePath: "a.ts" }), 1);
        return { text: "" };
      },
    }));
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(
      "You were stopped before finishing. Without calling any tool, answer the question now from what you read, in the cheapag-research block format with status: partial.",
    );
    expect(calls[1][1]).toBeUndefined();
    expect(calls[1][2]).toBeInstanceOf(AbortSignal);
    expect((calls[1][2] as AbortSignal).aborted).toBe(false);
    expect(calls[1][3]).toBe(true);
    expect(text).toMatch(/^FAIL r\w{4} .*\nreason: turn cap \(1\) reached\n/);
  },
);

test('"." scopes nothing, a trailing slash is dropped, and an absolute path is refused even inside the repo', async () => {
  const { repo, fake, research } = await scenario();
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  await research({ question: "q", paths: "." });
  expect(fake.recorded.prompts[0].parts).toEqual([{ type: "text", text: prompt("Question: q") }]);
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  await research({ question: "q", paths: "./src/,," });
  expect(fake.recorded.prompts[1].parts).toEqual([
    {
      type: "text",
      text: prompt("Question: q\nScope: look only under src; cite only files there."),
    },
  ]);
  const inside = join(repo.dir, "src");
  expect(await research({ question: "q", paths: inside })).toBe(
    `FAIL reason: path ${inside} must be inside the repository, relative to its root`,
  );
});

/** The brief block as the worker writes it. */
const brief = (fields: string) => `\`\`\`cheapag-research\n${fields}\n\`\`\``;

test("parseAnswer: no text is nothing, and text without a block is an UNSURE low-confidence answer", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "a.ts"), AUTH);
  expect(parseAnswer("", repo.dir, [], 200)).toBeUndefined();
  expect(parseAnswer(" \n ", repo.dir, [], 200)).toBeUndefined();
  expect(
    parseAnswer(" see src/a.ts:2 and src/a.ts:99\nthen more words ", repo.dir, [], 5),
  ).toStrictEqual({
    status: "UNSURE",
    answer: "see src/a.ts:2 and src/a.ts:99\nthen …",
    refs: [{ path: "src/a.ts", start: 2, end: 2 }],
    confidence: "low",
  });
});

test("parseAnswer: the last block wins; field names, aliases, partial, confidence and dead ends are read leniently", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const two = `${brief("status: answer\nnotes: first")}\n${brief("status: unsure\nconfidence: Medium, mostly\nnotes: second")}`;
  expect(parseAnswer(two, repo.dir, [], 200)).toStrictEqual({
    status: "UNSURE",
    partial: undefined,
    answer: "second",
    refs: [],
    confidence: "medium",
    repro: undefined,
    deadEnds: undefined,
  });
  const lenient = brief(
    "STATUS: Partial work\nconfidence: very high\nrepro: `a` → b\n  more repro\nDead_Ends: None.\nanswer: line one\nline two",
  );
  expect(parseAnswer(lenient, repo.dir, [], 200)).toStrictEqual({
    status: "ANSWER",
    partial: true,
    answer: "line one\nline two",
    refs: [],
    confidence: "low",
    repro: "`a` → b",
    deadEnds: undefined,
  });
  const extra =
    "```cheapag-research json\nstatus: answer\ndead ends:  the cache \nnotes:  prose \n```";
  expect(parseAnswer(extra, repo.dir, [], 200)).toMatchObject({
    answer: "prose",
    deadEnds: "the cache",
    confidence: "low",
  });
  expect(parseAnswer(brief("status: answer\ndead ends: x\nnotes:  "), repo.dir, [], 200)).toBe(
    undefined,
  );
});

test("parseAnswer: refs exist, are in range and in scope, are unique, and stop at 5; with none listed, the prose's refs count", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "srcx"));
  writeFileSync(join(repo.dir, "src", "a.ts"), AUTH);
  writeFileSync(join(repo.dir, "srcx", "c.ts"), AUTH);
  const listed = [
    "src/a.ts:1",
    "src/a.ts:1",
    "src/a.ts:0",
    "src/a.ts:5-3",
    "src:1",
    "srcx/c.ts:1",
    "src/a.ts:2",
    "src/a.ts:3-40",
    "src/a.ts:4",
    "src/a.ts:5",
    "src/a.ts:6",
  ].join(", ");
  expect(parseAnswer(brief(`files: ${listed}\nnotes: x`), repo.dir, ["src"], 200)?.refs).toEqual([
    { path: "src/a.ts", start: 1, end: 1 },
    { path: "src/a.ts", start: 2, end: 2 },
    { path: "src/a.ts", start: 3, end: 40 },
    { path: "src/a.ts", start: 4, end: 4 },
    { path: "src/a.ts", start: 5, end: 5 },
  ]);
  expect(
    parseAnswer(brief("refs: srcx/c.ts:1\nnotes: in src/a.ts:7-8"), repo.dir, ["src"], 200)?.refs,
  ).toEqual([{ path: "src/a.ts", start: 7, end: 8 }]);
});

const answered = { status: "ANSWER" as const, answer: "a", refs: [], confidence: "high" as const };

test("verifyRepro: no answer, no repro and not attempted pass through; a ran command (spaces collapsed, either way round) verifies", () => {
  expect(verifyRepro(undefined, [])).toBeUndefined();
  expect(verifyRepro({ ...answered, repro: "  " }, [])).toStrictEqual({
    ...answered,
    repro: undefined,
  });
  expect(verifyRepro({ ...answered, repro: " None " }, [])?.repro).toBe("None");
  expect(verifyRepro({ ...answered, repro: "NOT ATTEMPTED (read only)" }, [])?.repro).toBe(
    "NOT ATTEMPTED (read only)",
  );
  expect(verifyRepro({ ...answered, repro: " `npm   test` → ok " }, ["npm test --silent"])).toEqual(
    { ...answered, repro: "`npm   test` → ok" },
  );
  expect(
    verifyRepro({ ...answered, repro: "`npx vitest run test/a.test.ts` → ok" }, [
      "npx  vitest run",
    ]),
  ).toEqual({ ...answered, repro: "`npx vitest run test/a.test.ts` → ok" });
});

test("verifyRepro: a repro with no backticked command, or one never run, is unverified at low confidence", () => {
  for (const repro of ["ran the tests → ok", "`pytest` → 1 failed"])
    expect(verifyRepro({ ...answered, repro }, ["npm test"])).toEqual({
      ...answered,
      repro: `unverified (not run): ${repro}`,
      confidence: "low",
    });
});

test("verifyRepro: a bash call with no command verifies any backticked repro (current behaviour)", () => {
  expect(verifyRepro({ ...answered, repro: "`pytest` → 1 failed" }, [""])).toEqual({
    ...answered,
    repro: "`pytest` → 1 failed",
  });
});

test("a bash call without a command verifies any claimed repro end to end (current behaviour)", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { text } = await stubbed(repo, (opts) => ({
    run: async () => {
      opts.onEvent(toolEvent("bash", "completed"), 1);
      return block("status: answer\nconfidence: high\nrepro: `pytest` → 1 failed\nnotes: ok");
    },
  }));
  expect(text).toContain("\nrepro: `pytest` → 1 failed\n");
  expect(text).toContain("\nconfidence: high\n");
});
