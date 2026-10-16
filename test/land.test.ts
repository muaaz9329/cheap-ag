import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, snapshot, startServer, tempRepo } from "./harness.js";

const REPORT = { summary: "did it", risks: [], review: [], missing: [] };
// no backticked done-when: nothing to verify, so a job that finishes lands
const PLAN = ["# Land", "", ...["a", "b", "c"].flatMap((f, i) => [`## ${i + 1} write ${f}`, `files: ${f}.txt`, `do: write ${f}.txt`, `done-when: ${f}.txt written`, ""])].join("\n");

/** A repo with the plan written, a fake worker, and `start()` for each server process on it. */
async function setup() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "p.md"), PLAN);
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const start = async (env: Record<string, string> = {}) => {
    const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url, ...env }, logins: { "opencode-go": "k" }, allow: [] });
    onTestFinished(server.close);
    return { ...server, call: (tool: string, args: Record<string, unknown>) => callText(server.client, tool, args) };
  };
  const inRepo = (...p: string[]) => join(repo.dir, ...p);
  const record = (job: string) => JSON.parse(readFileSync(inRepo(".cheapag", "jobs", job, "result.json"), "utf8"));
  return { repo, fake, start, inRepo, record };
}

const jobOf = (text: string) => text.match(/^\w+ (j[0-9a-z]{4}) /m)![1];
const step = (id: string) => `>>> CURRENT STEP(S): ${id}\n`;
const writes = (file: string, content: string, ...more: Action[]): Action[] => [{ edit: file, content }, { tool: "write" }, ...more, { finish: REPORT }];

test("a landing conflict gets one redo from the current tree, with the step and the original diff; it lands OK with redo=1", async () => {
  const { repo, fake, start, inRepo, record } = await setup();
  const seen: { marked?: string } = {};
  fake.script(...writes("README.md", "# worker's title\n", { hook: () => writeFileSync(inRepo("README.md"), "# user's title\n\nuser's line\n") }));
  fake.scriptFor(">>> REDO STEP(S): 1\n",
    { hook: () => (seen.marked = readFileSync(join(fake.recorded.sessions[0].directory, "README.md"), "utf8")) },
    ...writes("README.md", "# user's and worker's title\n\nuser's line\n"));
  const text = await (await start()).call("delegate", { plan: ".plan/p.md", steps: "1" });
  const job = jobOf(text);

  expect(text).toMatch(new RegExp(`^OK ${job} step=1 files=1 \\+1/-1 tests=none turns=4 cost=\\$0\\.000 redo=1\n`));
  expect(readFileSync(inRepo("README.md"), "utf8")).toBe("# user's and worker's title\n\nuser's line\n");
  expect(existsSync(inRepo(".cheapag", "worktrees", job))).toBe(false);
  expect(record(job)).toMatchObject({ status: "OK", landed: true, redo: 1, worktree: null });
  expect(repo.git("status", "--porcelain", "--", "README.md")).toBe(" M README.md\n");

  // the same session was prompted once more: the step again, which files clash, and the original diff
  expect(fake.recorded.sessions).toHaveLength(1);
  const redo = (fake.recorded.prompts[1].parts[0] as { text: string }).text;
  expect(redo).toContain("conflict markers: README.md.");
  expect(redo).toContain("## 1 write a");
  expect(redo).toMatch(/```diff\n[\s\S]*-# fixture\n\+# worker's title\n/);
  // its fresh worktree was the current tree with the change applied again and the clash marked
  expect(seen.marked).toBe("<<<<<<< ours\n# user's title\n\nuser's line\n=======\n# worker's title\n>>>>>>> theirs\n");
});

test("in a batch the redo runs in landing order: CONFLICT names the job that landed first, later groups still land after it", async () => {
  const { start, fake, inRepo, record } = await setup();
  const seen: { cLanded?: boolean } = {};
  // groups 1 and 2 both retitle the README (outside their files:, so they run in parallel); 1 lands first
  fake.scriptFor(step("1"), ...writes("a.txt", "a\n", { edit: "README.md", content: "# one\n" }, { wait: 200 }));
  fake.scriptFor(step("2"), ...writes("b.txt", "b\n", { edit: "README.md", content: "# two\n" }));
  fake.scriptFor(">>> REDO STEP(S): 2\n", { hook: () => (seen.cLanded = existsSync(inRepo("c.txt"))) }); // reconciles nothing
  fake.scriptFor(step("3"), ...writes("c.txt", "c\n"));
  const text = await (await start()).call("delegate", { plan: ".plan/p.md", steps: "1,2,3" });
  const batch = JSON.parse(readFileSync(inRepo(".cheapag", "batches", `${text.match(/^BATCH (b[0-9a-z]{4})/)![1]}.json`), "utf8"));
  const [j1, j2, j3] = batch.jobs;

  expect(text.split("\n")[0]).toMatch(/^BATCH b[0-9a-z]{4} groups=3 CONFLICT=1 OK=2 landed=2 /);
  expect(text).toContain(`\nconflict:\n  README.md (also changed by ${j1}, landed first; redo left conflict markers)\nworktree: .cheapag/worktrees/${j2}/\n`);
  expect(batch.landed).toEqual([j1, j3]);
  expect(seen.cLanded).toBe(false); // group 3 waited for group 2's redo
  expect(readFileSync(inRepo("README.md"), "utf8")).toBe("# one\n");
  expect(existsSync(inRepo("b.txt"))).toBe(false);
  expect(record(j2)).toMatchObject({ status: "CONFLICT", landed: false, redo: 1 });
});

test("land apply lands unlanded jobs in the given order, stopping at a conflict; land discard removes worktrees, never the linked deps", async () => {
  const { start, fake, inRepo, record } = await setup();
  mkdirSync(inRepo("node_modules", "pkg"), { recursive: true });
  writeFileSync(inRepo("node_modules", "pkg", "index.js"), "dep\n");
  const broken = (file: string, content: string): Action[] => [{ edit: file, content }, { tool: "write" }, { error: { name: "APIError", message: "boom" } }];
  fake.script(...broken("a.txt", "from A\n"));
  fake.script(...broken("a.txt", "from B\n")); // clashes with A once A has landed
  fake.script(...broken("c.txt", "from C\n"));
  const server = await start();
  const ids: string[] = [];
  for (const s of ["1", "2", "3"]) {
    const text = await server.call("delegate", { plan: ".plan/p.md", steps: s });
    expect(text).toMatch(/^FAIL /);
    ids.push(jobOf(text));
  }
  const [ja, jb, jc] = ids;
  expect(existsSync(inRepo(".cheapag", "worktrees", jb, "node_modules"))).toBe(true);

  expect(await server.call("land", { job: `${ja}, ${jb},${jc}`, action: "apply" })).toBe([
    `OK ${ja} applied files=1 +1/-0`,
    `FAIL ${jb} reason: landing conflict in a.txt, working tree untouched; discard it, or fix the overlap and delegate again`,
    `FAIL ${jc} reason: not applied, since ${jb} before it did not land`,
  ].join("\n"));
  expect(readFileSync(inRepo("a.txt"), "utf8")).toBe("from A\n");
  expect(existsSync(inRepo("c.txt"))).toBe(false);
  expect(existsSync(inRepo(".cheapag", "worktrees", ja))).toBe(false);
  expect(record(ja)).toMatchObject({ status: "FAIL", landed: true, worktree: null });
  expect(record(jb)).toMatchObject({ landed: false, worktree: `.cheapag/worktrees/${jb}` });

  expect(await server.call("land", { job: `${jb},${jc}`, action: "discard" })).toBe(`OK ${jb} discarded\nOK ${jc} discarded`);
  for (const j of [jb, jc]) {
    expect(existsSync(inRepo(".cheapag", "worktrees", j))).toBe(false);
    expect(record(j)).toMatchObject({ landed: false, worktree: null, discarded: true });
  }
  expect(readFileSync(inRepo("node_modules", "pkg", "index.js"), "utf8")).toBe("dep\n"); // the link was removed, not followed
  expect(readFileSync(inRepo(".cheapag", "jobs", jb, "result.txt"), "utf8")).not.toContain("worktree:");

  // clear refusals
  expect(await server.call("land", { job: ja, action: "apply" })).toBe(`FAIL ${ja} reason: job ${ja} already landed`);
  expect(await server.call("land", { job: jb, action: "apply" })).toBe(`FAIL ${jb} reason: job ${jb} was already discarded`);
  expect(await server.call("land", { job: "jzzzz", action: "discard" })).toBe("FAIL jzzzz reason: job jzzzz not found");
  expect(await server.call("land", { job: "../x", action: "discard" })).toBe("FAIL ../x reason: ../x is not a job id, e.g. j7f3a");
});

test("land refuses a job that is still live", async () => {
  const { start, fake } = await setup();
  fake.script({ edit: "a.txt", content: "a\n" }, { question: "which?", options: ["x", "y"] });
  const server = await start();
  const text = await server.call("delegate", { plan: ".plan/p.md", steps: "1" });
  const job = jobOf(text);
  expect(text).toMatch(/^BLOCKED /);
  expect(await server.call("land", { job, action: "discard" })).toBe(`FAIL ${job} reason: job ${job} is still BLOCKED; wait for it, or cancel it first`);
  await server.call("jobs", { action: "cancel", job });
});

test("a lock left by a dead process is broken automatically", async () => {
  const { start, fake, inRepo } = await setup();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(inRepo(".cheapag"), { recursive: true });
  writeFileSync(inRepo(".cheapag", "land.lock"), JSON.stringify({ pid: dead, at: new Date().toISOString() }));
  fake.script(...writes("a.txt", "a\n"));
  expect(await (await start()).call("delegate", { plan: ".plan/p.md", steps: "1" })).toMatch(/^OK /);
  expect(readFileSync(inRepo("a.txt"), "utf8")).toBe("a\n");
  expect(readdirSync(inRepo(".cheapag")).filter((f) => f.startsWith("land.lock"))).toEqual([]);
});

test("waiting for a lock held by a live process times out with a clear FAIL; the tree is untouched", async () => {
  const { start, fake, inRepo } = await setup();
  mkdirSync(inRepo(".cheapag"), { recursive: true });
  // this test process is alive: it holds the lock for the whole wait
  const held = JSON.stringify({ pid: process.pid, at: "2026-10-16T10:00:00.000Z" });
  writeFileSync(inRepo(".cheapag", "land.lock"), held);
  fake.script(...writes("a.txt", "a\n"));
  const before = snapshot(inRepo());
  // the 10-minute wait shortened through the test hook
  const text = await (await start({ CHEAPAG_LOCK_TIMEOUT_MS: "500" })).call("delegate", { plan: ".plan/p.md", steps: "1" });
  expect(text).toMatch(/^FAIL /);
  expect(text).toContain(`\nreason: timed out after 0.5 s waiting for .cheapag/land.lock (held by pid ${process.pid} since 2026-10-16T10:00:00.000Z); try again once it is released\n`);
  expect(snapshot(inRepo())).toEqual(before);
  expect(readFileSync(inRepo(".cheapag", "land.lock"), "utf8")).toBe(held); // never someone else's to remove
});

test("two server processes on one repository wait for the lock and land one at a time", async () => {
  const { start, fake, inRepo } = await setup();
  mkdirSync(inRepo(".cheapag"), { recursive: true });
  writeFileSync(inRepo(".cheapag", "land.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fake.scriptFor(step("1"), ...writes("a.txt", "a\n"));
  fake.scriptFor(step("2"), ...writes("b.txt", "b\n"));
  const [one, two] = await Promise.all([start(), start()]);
  const results = [one.call("delegate", { plan: ".plan/p.md", steps: "1" }), two.call("delegate", { plan: ".plan/p.md", steps: "2" })];

  // both are ready to land, each waiting with its own pending lock file, and neither has touched the tree
  const waiting = () => readdirSync(inRepo(".cheapag")).filter((f) => f.startsWith("land.lock.")).map((f) => Number(f.split(".")[2])).sort();
  await vi.waitFor(() => expect(waiting()).toEqual([one.pid, two.pid].sort()), { timeout: 5000 });
  expect(existsSync(inRepo("a.txt")) || existsSync(inRepo("b.txt"))).toBe(false);

  rmSync(inRepo(".cheapag", "land.lock"));
  for (const text of await Promise.all(results)) expect(text).toMatch(/^OK /);
  expect(readFileSync(inRepo("a.txt"), "utf8")).toBe("a\n");
  expect(readFileSync(inRepo("b.txt"), "utf8")).toBe("b\n");
  expect(readdirSync(inRepo(".cheapag")).filter((f) => f.startsWith("land.lock"))).toEqual([]);
});
