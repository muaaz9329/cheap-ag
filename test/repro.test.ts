import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { startServer, tempRepo } from "./harness.js";

// The step's check passes once src/hello.ts exports 2; the worker's reproduction test checks the same thing.
const CHECK = `import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("src/hello.ts", "utf8").includes("= 2") ? 0 : 1);\n`;
const REPRO = CHECK;
const PASSES_ANYWAY = "process.exit(0);\n";
/** Passes on the fix, then puts the fix file back to its base content, so setting it aside has nothing to save. */
const REVERTS_FIX = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const fixed = readFileSync("src/hello.ts", "utf8").includes("= 2");',
  'writeFileSync("src/hello.ts", "export const hello = 0;\\n");',
  "process.exit(fixed ? 0 : 1);",
  "",
].join("\n");
/** Fails on the base unless the added file is gone, so it proves the added file is set aside for the reproduction. */
const NEEDS_ADDED_FILE = [
  'import { existsSync, readFileSync } from "node:fs";',
  'const fixed = readFileSync("src/hello.ts", "utf8").includes("= 2");',
  'if (!fixed) process.exit(existsSync("src/extra.ts") ? 0 : 1);',
  'process.exit(existsSync("src/extra.ts") ? 0 : 3);',
  "",
].join("\n");
/** Records each run at RUNS_LOG (outside the worktree, so landing cannot overwrite it), then checks the fix. */
const COUNTS_RUNS = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'appendFileSync(RUNS_LOG, "run,");',
  'process.exit(readFileSync("src/hello.ts", "utf8").includes("= 2") ? 0 : 1);',
  "",
].join("\n");
/** Leaves a marker at RAN_LOG if it ever runs, so a feature step's missing repro check is visible. */
const LEAVES_MARKER = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'writeFileSync(RAN_LOG, "ran");',
  'process.exit(readFileSync("src/hello.ts", "utf8").includes("= 2") ? 0 : 1);',
  "",
].join("\n");

function stashInMain(repo: ReturnType<typeof tempRepo>) {
  writeFileSync(join(repo.dir, "README.md"), "# fixture\n\nuser edit\n");
  repo.git("stash", "push", "-u", "-m", "user stash");
}

type DelegateOptions = {
  reproTest?: string | ((repo: ReturnType<typeof tempRepo>) => string);
  beforeJob?: (repo: ReturnType<typeof tempRepo>) => void;
  files?: Record<string, string>;
  task?: string;
  doneWhen?: string;
};

async function delegate(repro: string, opts: DelegateOptions = {}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "check.mjs"), CHECK);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "hello.ts"), "export const hello = 0;\n");
  // the project lets jobs run node scripts, so `node test/...` counts as one of the job's check commands
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ allow_commands: ["node"] }));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  opts.beforeJob?.(repo);
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const reproTest =
    typeof opts.reproTest === "function" ? opts.reproTest(repo) : (opts.reproTest ?? REPRO);
  const script: Action[] = [
    { edit: "test/hello.test.mjs", content: reproTest },
    { edit: "src/hello.ts", content: "export const hello = 2;\n" },
    ...Object.entries(opts.files ?? {}).map(([edit, content]) => ({ edit, content })),
    { tool: "write" },
    { finish: { summary: "fixed hello", risks: [], review: [], missing: [], repro } as never },
  ];
  fake.script(...script);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: [],
  });
  onTestFinished(server.close);
  const result = await server.client.callTool({
    name: "delegate",
    arguments: {
      task: opts.task ?? "fix hello: make hello 2",
      files: "src/hello.ts, test/",
      done_when: opts.doneWhen ?? "`node check.mjs`",
    },
  });
  const text = (result.content as { text: string }[])[0].text;
  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)![1];
  const record = JSON.parse(
    readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"),
  );
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
  const { text, record } = await delegate("node test/hello.test.mjs", { reproTest: PASSES_ANYWAY });
  expect(record.repro).toBe("unverified");
  expect(record.risks[0]).toBe(
    "nothing to do (the checks passed), reproduction not verified: `node test/hello.test.mjs` also passes without the fix",
  );
  expect(text).toContain(
    "nothing to do (the checks passed), reproduction not verified: `node test/hello.test.mjs` also passes without the fix",
  );
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
  const { text, record } = await delegate("n/a", { task: "make hello 2" });
  expect(record.repro).toBeUndefined();
  expect(text.split("\n")[0]).not.toContain("repro=");
});

test("a feature step runs no reproduction check and records no repro", async () => {
  const ranLog = (repo: ReturnType<typeof tempRepo>) => join(repo.dir, "ran.log");
  const { repo, text, record } = await delegate("node test/hello.test.mjs", {
    task: "make hello 2",
    reproTest: (r) => LEAVES_MARKER.replace("RAN_LOG", JSON.stringify(ranLog(r))),
  });
  expect(record.repro).toBeUndefined();
  expect(text.split("\n")[0]).not.toContain("repro=");
  expect(record.risks).toEqual([]);
  // the repro command never ran, not even on the fixed tree
  expect(() => readFileSync(ranLog(repo))).toThrow();
});

test("a fix whose claim is one of the passing checks runs it once fewer: repro=fail→pass", async () => {
  const runsLog = (repo: ReturnType<typeof tempRepo>) => join(repo.dir, "runs.log");
  const { repo, record } = await delegate("node test/hello.test.mjs", {
    reproTest: (r) => COUNTS_RUNS.replace("RUNS_LOG", JSON.stringify(runsLog(r))),
    doneWhen: "`node test/hello.test.mjs`",
  });
  expect(record.repro).toBe("fail→pass");
  // verify ran it once, then the without-the-fix run once; the fixed-code rerun was skipped
  expect(readFileSync(runsLog(repo), "utf8").split(",").filter(Boolean)).toHaveLength(2);
});

test("a user stash in the main checkout survives a repro check", async () => {
  const { repo, record } = await delegate("node test/hello.test.mjs", { beforeJob: stashInMain });
  expect(record.repro).toBe("fail→pass");
  expect(repo.git("stash", "list")).toContain("user stash");
});

test("a repro check that sets aside nothing leaves the user's stash untouched", async () => {
  const { repo, record } = await delegate("node test/hello.test.mjs", {
    reproTest: REVERTS_FIX,
    beforeJob: stashInMain,
  });
  expect(record.repro).toBe("fail→pass");
  expect(repo.git("stash", "list")).toContain("user stash");
});

test("a file the fix added is removed for the reproduction and restored afterwards", async () => {
  const { repo, record } = await delegate("node test/hello.test.mjs", {
    reproTest: NEEDS_ADDED_FILE,
    files: { "src/extra.ts": "export const extra = true;\n" },
  });
  expect(record.repro).toBe("fail→pass");
  expect(readFileSync(join(repo.dir, "src", "extra.ts"), "utf8")).toBe(
    "export const extra = true;\n",
  );
});

/** Passes on the fix, and leaves the fix file read-only: it can then neither be set aside nor restored. */
const LOCKS_FIX = [
  'import { chmodSync, readFileSync } from "node:fs";',
  'const fixed = readFileSync("src/hello.ts", "utf8").includes("= 2");',
  'chmodSync("src/hello.ts", 0o444);',
  "process.exit(fixed ? 0 : 1);",
  "",
].join("\n");

// permission bits mean nothing to root or on Windows
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a fix that cannot be set aside for the reproduction: repro=unverified, and the fix still lands as it was",
  async () => {
    const { repo, text, record } = await delegate("node test/hello.test.mjs", {
      reproTest: LOCKS_FIX,
    });
    expect(text.split("\n")[0]).toMatch(/^OK j\w+ /);
    expect(record.repro).toBe("unverified");
    expect(record.risks[0]).toBe(
      "nothing to do (the checks passed), reproduction not verified: could not set the fix aside to rerun the reproduction",
    );
    expect(readFileSync(join(repo.dir, "src", "hello.ts"), "utf8")).toBe(
      "export const hello = 2;\n",
    );
  },
);
