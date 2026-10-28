import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";

// ticket 28: the worker gets the user's own words next to Claude's task, and says where they disagree
const DONE: Action = { finish: { summary: "made hello", risks: [], review: [], missing: [], repro: "n/a", disagree: "none" } as never };

async function run(args: Record<string, unknown>, finish: Action = DONE, files: Record<string, string> = {}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "docs"));
  writeFileSync(join(repo.dir, "docs", "issue.md"), "# Marks are lost with two base classes\n\nWalk the MRO forwards.\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo.dir, name), content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script({ edit: "src/hello.ts", content: "export const hello = 2;\n" }, { tool: "write" }, finish);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const result = await server.client.callTool({ name: "delegate", arguments: { task: "make hello 2", files: "src/", ...args } });
  const text = (result.content as { text: string }[])[0].text;
  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)![1];
  const prompt = JSON.stringify(fake.recorded.prompts[0].parts);
  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  return { text, prompt, record };
}

test("source text reaches the worker after the step, marked as the user's words to check the step against", async () => {
  const { text, prompt, record } = await run({ source: "Marks are lost with two base classes. Walk the MRO forwards." });
  expect(text).toMatch(/^OK /);
  expect(prompt).toContain("Source (the user's request or the issue, verbatim; check the step against it");
  expect(prompt).toContain("Walk the MRO forwards.");
  expect(prompt.indexOf(">>> CURRENT STEP")).toBeLessThan(prompt.indexOf("Source ("));
  expect(record.risks).toEqual([]); // disagree: none adds nothing
});

test("source as a repo-relative file path is read; a long source is cut at 8,000 characters", async () => {
  const { prompt } = await run({ source: "docs/issue.md" });
  expect(prompt).toContain("# Marks are lost with two base classes");
  // inline text is capped by the schema; a file is cut by the server
  const long = await run({ source: "docs/long.md" }, DONE, { "docs/long.md": "x".repeat(8500) + "END" + "y".repeat(100) });
  expect(long.prompt).toContain("[… cut at 8000 characters]");
  expect(long.prompt).not.toContain("END");
});

test("a disagreement the worker reports leads the risks, so Claude sees its own spec questioned", async () => {
  const { text, record } = await run(
    { source: "Walk the MRO forwards." },
    { finish: { summary: "made hello", risks: ["untested on py2"], review: [], missing: [], repro: "n/a", disagree: "the step says reversed(__mro__); the source walks it forwards" } as never },
  );
  expect(record.risks).toEqual(["spec vs source: the step says reversed(__mro__); the source walks it forwards", "untested on py2"]);
  expect(text).toContain("\nrisks:\n  - spec vs source: the step says reversed(__mro__); the source walks it forwards\n");
});
