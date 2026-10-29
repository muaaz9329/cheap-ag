import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { BRIEF_FORMAT, REPRO_RULE, refTokens } from "../src/research.js";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, slow, startServer, tempRepo, type Logins } from "./harness.js";

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
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: opts.logins ?? { "opencode-go": "k" }, allow: opts.allow === null ? undefined : (opts.allow ?? []) });
  onTestFinished(server.close);
  const research = (args: Record<string, unknown>) => callText(server.client, "research", args);
  return { repo, fake, server, research };
}

const block = (fields: string) => ({ text: `Found it.\n\`\`\`cheapag-research\n${fields}\n\`\`\`` });
/** The repro rule, then the word cap, then the brief format: every research prompt (src/research.ts). */
const prompt = (head: string, words = 200) => `${head}\n${REPRO_RULE}\nAnswer in at most ${words} words.\n${BRIEF_FORMAT}`;

const idOf = (text: string) => text.match(/^\w+ (r[0-9a-z]{4}) /)![1];

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
  expect(text).toContain("send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)");
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
  expect(fake.recorded.requests).toEqual([]);
});

test("answers from the main checkout, uncommitted work included, with validated refs and confidence; the tree is untouched", async () => {
  const { repo, fake, server, research } = await scenario();
  // everything but Cheap Agent's own state
  const tree = () => repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => !l.includes(".cheapag/")).join("\n");
  const before = tree();
  fake.script(
    { tool: "read", input: { filePath: join(repo.dir, "src", "auth.ts") } },
    { tool: "read", input: { filePath: join(repo.dir, "src", "auth.ts") } },
    { tool: "read", input: { filePath: join(repo.dir, "README.md") } },
    { tool: "grep", input: { pattern: "verify" } },
    { usage: { cost: 0.003, input: 2000, output: 100 } },
    block([
      "status: answer",
      "confidence: High",
      // kept: in range, absolute path made relative; dropped: past the end, missing file, outside the repo
      `refs: src/auth.ts:18-22, ${join(repo.dir, "src", "app.ts")}:1, src/auth.ts:39-41, src/nope.ts:3, ../outside.ts:1`,
      "answer:",
      "JWT is validated in src/auth.ts:18-22,",
      "called from src/app.ts:1.",
    ].join("\n")),
  );
  const text = await research({ question: "where is JWT validated?" });
  const id = idOf(text);
  expect(text).toBe([
    `ANSWER ${id} files_read=2 turns=4 cost=$0.003`,
    "files: src/auth.ts:18-22, src/app.ts:1",
    "notes:",
    "JWT is validated in src/auth.ts:18-22,",
    "called from src/app.ts:1.",
    "confidence: high",
    `log: .cheapag/jobs/${id}/`,
  ].join("\n"));

  // its own agent and ruleset (read, search, test commands; never edit), in a throwaway worktree, on the research model
  const [session] = fake.recorded.sessions;
  expect(session).toMatchObject({ directory: join(repo.dir, ".cheapag", "worktrees", id), agent: "cheapag-research", model: { providerID: "opencode-go", id: "qwen3.8-flash" } });
  expect(session.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
  expect(session.permission).toContainEqual({ permission: "bash", pattern: "pytest *", action: "allow" });
  expect(fake.recorded.prompts[0].parts).toEqual([{ type: "text", text: prompt("Question: where is JWT validated?") }]);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees", id))).toBe(false); // removed once answered
  expect(tree()).toBe(before);

  // the record and the block are logged; `jobs list` does not mistake research for a job
  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", id, "research.json"), "utf8"));
  expect(record).toMatchObject({ format: "cheapag/1", job: id, kind: "research", status: "ANSWER", unlanded: [], models: { requested: "opencode-go/qwen3.8-flash", final: "opencode-go/qwen3.8-flash" } });
  expect(readFileSync(join(repo.dir, ".cheapag", "jobs", id, "result.txt"), "utf8")).toBe(text + "\n");
  expect(await callText(server.client, "jobs", { action: "list" })).toBe("no jobs yet");
});

test("max_words caps the answer (default 200, at most 600) and long prose is wrapped, not elided", async () => {
  const { fake, research } = await scenario();
  const long = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
  fake.script(block(`status: answer\nconfidence: medium\nanswer: ${long}`));
  const capped = await research({ question: "q", max_words: 5 });
  expect(capped.split("\n").slice(1, 3)).toEqual(["notes:", "w0 w1 w2 w3 w4 …"]);
  expect(fake.recorded.prompts[0].parts).toEqual([{ type: "text", text: prompt("Question: q", 5) }]);

  fake.script(block(`status: answer\nconfidence: medium\nanswer: ${long}`));
  const most = await research({ question: "q", max_words: 5000 });
  expect(fake.recorded.prompts[1].parts).toEqual([{ type: "text", text: prompt("Question: q", 600) }]);
  const prose = most.split("\n").slice(2, -2).join(" ");
  expect(prose).toBe(`${long.split(" ").slice(0, 600).join(" ")} …`);
  for (const line of most.split("\n")) expect(line.length).toBeLessThanOrEqual(200);
});

test("paths scope the search: the prompt names them, refs outside are dropped, and bad paths FAIL before anything runs", async () => {
  const { fake, research } = await scenario();
  fake.script(block("status: answer\nconfidence: high\nrefs: src/auth.ts:1, README.md:1\nanswer: see auth"));
  const text = await research({ question: "q", paths: " src , src/app.ts" });
  expect(fake.recorded.prompts[0].parts).toEqual([{ type: "text", text: prompt("Question: q\nScope: look only under src, src/app.ts; cite only files there.") }]);
  expect(text).toContain("\nfiles: src/auth.ts:1\n");

  expect(await research({ question: "q", paths: "../elsewhere" })).toBe("FAIL reason: path ../elsewhere must be inside the repository, relative to its root");
  expect(await research({ question: "q", paths: "/etc" })).toBe("FAIL reason: path /etc must be inside the repository, relative to its root");
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
  expect(fake.recorded.prompts[0].parts).toEqual([{ type: "text", text: prompt("Question: q\nScope: look only under README.md; cite only files there.") }]);

  expect(await research({ question: "q", paths: "x/util.ts" })).toBe("FAIL reason: path x/util.ts not found; did you mean: a/util.ts, b/util.ts");
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("UNSURE: when the worker says so, and (low confidence) when it answers without the block; FAIL when it says nothing", async () => {
  const { fake, research } = await scenario();
  fake.script(block("status: unsure\nconfidence: low\nanswer: no refresh endpoint found"));
  expect(await research({ question: "q" })).toMatch(/^UNSURE r\w{4} .*\nnotes:\nno refresh endpoint found\nconfidence: low\n/);
  fake.script({ text: "It is in src/auth.ts:3 I think." });
  expect(await research({ question: "q" })).toMatch(/^UNSURE r\w{4} .*\nfiles: src\/auth.ts:3\nnotes:\nIt is in src\/auth.ts:3 I think.\nconfidence: low\n/);
  fake.script();
  expect(await research({ question: "q" })).toMatch(/^FAIL r\w{4} files_read=0 turns=0 cost=\$0.000\nreason: the research worker gave no answer\nlog: /);
  fake.script({ error: { name: "ProviderAuthError", message: "bad key" } });
  expect(await research({ question: "q" })).toMatch(/\nreason: worker error: bad key\n/);
});

test("a Go limit on the research model falls back to DeepSeek Flash in the same session; limits on both → BUDGET", async () => {
  const { fake, research } = await scenario();
  fake.script({ usage: { cost: 0.001 } }, { retry: { reason: "account_rate_limit", message: "Resets in 2h" } });
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  const text = await research({ question: "q" });
  expect(text).toMatch(/^ANSWER r\w{4} files_read=0 turns=0 cost=\$0.001 model=opencode-go\/deepseek-v4.1-flash\nnotes:\nok\n/);
  // the shared routing machinery: one session, the fallback named on the continued prompt (src/routing.ts)
  expect(fake.recorded.sessions.map((s) => s.model?.id)).toEqual(["qwen3.8-flash"]);
  expect(fake.recorded.prompts.map((p) => p.model?.modelID)).toEqual([undefined, "deepseek-v4.1-flash"]);
  expect(fake.recorded.aborts).toEqual([fake.recorded.sessions[0].id]);

  fake.script({ retry: { reason: "account_rate_limit", message: "Resets in 2h" } });
  fake.script({ retry: { reason: "free_tier_limit", message: "Resets in 5h" } });
  const capped = await research({ question: "q" });
  expect(capped).toMatch(/^BUDGET r\w{4} .* model=opencode-go\/deepseek-v4.1-flash\nreason: /);
  expect(capped).toContain("qwen3.8-flash"); // the reason names every capped model (src/routing.ts exhausted())
});

test("the allowlist applies: without the research model, research runs on the allowed implement model", async () => {
  const { fake, research } = await scenario({ allow: ["--models", "opencode-go/deepseek-v4.1-flash"] });
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  expect(await research({ question: "q" })).toMatch(/^ANSWER r\w{4} files_read=0 turns=0 cost=\$0.000\nnotes:\nok\n/);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash" });
});

test("note lists unlanded jobs: in flight, or unlanded changes in a worktree that still exists", async () => {
  const { repo, fake, research } = await scenario();
  const job = (id: string, startedAt: string, fields: Record<string, unknown>) => {
    mkdirSync(join(repo.dir, ".cheapag", "jobs", id), { recursive: true });
    writeFileSync(join(repo.dir, ".cheapag", "jobs", id, "result.json"), JSON.stringify({ job: id, landed: false, changed: [], worktree: null, timing: { startedAt }, ...fields }));
  };
  mkdirSync(join(repo.dir, ".cheapag", "worktrees", "j0002"), { recursive: true });
  job("j0002", "2026-10-02", { status: "FAIL", worktree: ".cheapag/worktrees/j0002", changed: [{ status: "M", path: "README.md", add: 1, del: 0 }] });
  job("j0001", "2026-10-01", { status: "BLOCKED" });
  job("j0003", "2026-10-03", { status: "OK", landed: true });
  job("j0004", "2026-10-04", { status: "FAIL", worktree: ".cheapag/worktrees/j0004" }); // changed nothing
  job("j0005", "2026-10-05", { status: "PARTIAL", worktree: ".cheapag/worktrees/j0005", changed: [{ status: "A", path: "x", add: 1, del: 0 }] }); // worktree discarded
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  expect(await research({ question: "q" })).toContain("\nnote: 2 jobs not yet landed (j0001, j0002); their changes are not visible to research\n");
});

test("runs while a delegate job is running, and notes that job as not yet landed", async () => {
  const { repo, fake, server, research } = await scenario();
  writeFileSync(join(repo.dir, "plan.md"), "# P\n## 1 hello\nfiles: hello.txt\ndo: write hello.txt\ndone-when: hello exists\n");
  fake.script({ edit: "hello.txt", content: "hi\n" }, { tool: "write" }, { wait: 60_000 }, { finish: { summary: "wrote hello", risks: [], review: [], missing: [] } });
  const delegated = callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  await vi.waitFor(() => expect(fake.recorded.prompts).toHaveLength(1), { timeout: 10_000 });
  fake.script(block("status: answer\nconfidence: high\nanswer: ok"));
  const text = await research({ question: "q" });
  expect(text).toMatch(/^ANSWER r\w{4} /);
  const job = text.match(/note: 1 job not yet landed \((j\w{4})\)/)![1];
  expect(await callText(server.client, "jobs", { action: "cancel", job })).toMatch(/^CANCELLED /);
  expect(await delegated).toMatch(/^CANCELLED /);
}, slow(30_000));

test("a scout brief: ranked files, a reproduction the worker ran, dead ends, notes", async () => {
  const { fake, research } = await scenario();
  fake.script(
    { tool: "bash", input: { command: "pytest tests/test_auth.py -k expiry", description: "repro" }, output: "1 failed" },
    block([
      "status: answer", "confidence: high", "files: src/auth.ts:18-22, src/app.ts:1",
      "repro: `pytest tests/test_auth.py -k expiry` → 1 failed: TokenExpiredError not caught",
      "dead ends: the middleware order is fine", "notes: the expiry check runs after decoding",
    ].join("\n")),
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
  fake.script(block("status: answer\nconfidence: high\nrepro: `pytest tests/test_auth.py` → 1 failed\ndead ends: none\nnotes: it fails"));
  const text = await research({ question: "why does it fail?" });
  expect(text).toContain("\nrepro: unverified (not run): `pytest tests/test_auth.py` → 1 failed\n");
  expect(text).not.toContain("dead ends:"); // "none" is not shown
  expect(text).toContain("\nconfidence: low\n");
  fake.script(block("status: answer\nconfidence: medium\nrepro: not attempted\nnotes: read only"));
  expect(await research({ question: "where is it?" })).toMatch(/\nrepro: not attempted\n[\s\S]*\nconfidence: medium\n/);
});

test("a turn cap recovers what the worker read: one no-tool prompt, rendered as ANSWER status=partial; other failures stay FAIL", async () => {
  const { repo, fake, research } = await scenario();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ limits: { max_turns: 2 } }));
  fake.script({ tool: "read" }, { tool: "grep" }, { wait: 60_000 });
  fake.script(block("status: partial\nconfidence: medium\nrefs: src/auth.ts:18-22\nanswer:\nSo far: validation looks to be in src/auth.ts:18-22."));
  const text = await research({ question: "where is JWT validated?" });
  expect(text).toMatch(/^ANSWER r\w{4} files_read=1 turns=2 cost=\$0.000 status=partial\nfiles: src\/auth.ts:18-22\nnotes:\nSo far: /);
  expect(text).toContain("\nreason: turn cap (2) reached\n");
  expect(fake.recorded.prompts[1].parts).toMatchObject([{ text: expect.stringContaining("status: partial") }]);

  // a partial reply that does not parse is the old FAIL
  fake.script({ tool: "read" }, { tool: "grep" }, { wait: 60_000 });
  expect(await research({ question: "q" })).toMatch(/^FAIL r\w{4} .*\nreason: turn cap \(2\) reached\n/);
});
