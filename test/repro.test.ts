import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";

// The step's check passes once src/hello.ts exports 2; the worker's reproduction test checks the same thing.
const CHECK = `import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("src/hello.ts", "utf8").includes("= 2") ? 0 : 1);\n`;
const REPRO = CHECK;
const PASSES_ANYWAY = "process.exit(0);\n";

async function delegate(repro: string, reproTest = REPRO) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "check.mjs"), CHECK);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "hello.ts"), "export const hello = 0;\n");
  // the project lets jobs run node scripts, so `node test/...` counts as one of the job's check commands
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ allow_commands: ["node"] }));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const script: Action[] = [
    { edit: "test/hello.test.mjs", content: reproTest },
    { edit: "src/hello.ts", content: "export const hello = 2;\n" },
    { tool: "write" },
    { finish: { summary: "fixed hello", risks: [], review: [], missing: [], repro } as never },
  ];
  fake.script(...script);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const result = await server.client.callTool({ name: "delegate", arguments: { task: "make hello 2", files: "src/hello.ts, test/", done_when: "`node check.mjs`" } });
  const text = (result.content as { text: string }[])[0].text;
  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)![1];
  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  return { repo, text, record };
}

test("a reproduction that fails without the fix and passes with it: OK repro=fail→pass, landed with the test", async () => {
  const { repo, text, record } = await delegate("node test/hello.test.mjs");
  expect(text.split("\n")[0]).toMatch(/^OK j\w+ .* repro=fail→pass test=test\/hello\.test\.mjs$/);
  expect(record.repro).toBe("fail→pass");
  expect(record.risks).toEqual([]);
  // the check ran in the worktree; the landed tree has the fix and the test
  expect(readFileSync(join(repo.dir, "src", "hello.ts"), "utf8")).toBe("export const hello = 2;\n");
  expect(readFileSync(join(repo.dir, "test", "hello.test.mjs"), "utf8")).toBe(REPRO);
});

test("a reproduction that also passes on the original code: repro=unverified with a risk", async () => {
  const { text, record } = await delegate("node test/hello.test.mjs", PASSES_ANYWAY);
  expect(record.repro).toBe("unverified");
  expect(text).toContain("reproduction not verified: `node test/hello.test.mjs` also passes without the fix");
});

test("no reproduction: repro=none with the worker's reason as a risk", async () => {
  const { record } = await delegate("none: needs a running database");
  expect(record.repro).toBe("none");
  expect(record.risks[0]).toBe("no reproduction: needs a running database");
});

test("a command outside this job's checks is never run: repro=unverified", async () => {
  const { repo, record } = await delegate("touch PWNED && node test/hello.test.mjs");
  expect(record.repro).toBe("unverified");
  expect(record.risks[0]).toMatch(/is not one of this job's check commands/);
  expect(() => readFileSync(join(repo.dir, "PWNED"))).toThrow();
});

test("a step that is not a fix: no repro token, no risk", async () => {
  const { text, record } = await delegate("n/a");
  expect(record.repro).toBeUndefined();
  expect(text.split("\n")[0]).not.toContain("repro=");
});
