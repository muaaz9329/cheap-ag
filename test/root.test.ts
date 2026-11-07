import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { allowRepo, callText, homeEnv, removeDir, startServer, tempRepo } from "./harness.js";

const DONE: Action = { finish: { summary: "added there", risks: [], review: [], missing: [] } };

/** A server started in repo `here` (allowed), and a second allowed repo `there` that calls reach only through `root`. */
async function scenario(actions: Action[]) {
  const here = tempRepo();
  onTestFinished(here.cleanup);
  const there = tempRepo();
  onTestFinished(there.cleanup);
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(...actions);
  const env = { CHEAPAG_OPENCODE_URL: fake.url };
  const server = await startServer({ cwd: here.dir, env, logins: { "opencode-go": "go-key" }, allow: [] });
  onTestFinished(server.close);
  allowRepo(there.dir, { ...homeEnv(server.home), ...env });
  return { here, there, fake, server, env };
}

const record = (root: string, job: string) => JSON.parse(readFileSync(join(root, ".cheapag", "jobs", job, "result.json"), "utf8"));

test("delegate with root runs in that repository and lands there, not in the server's cwd; jobs, land and reply follow the root", async () => {
  const { here, there, server } = await scenario([{ edit: "src/there.ts", content: "export const there = 1;\n" }, DONE]);
  const text = await callText(server.client, "delegate", { task: "Add src/there.ts exporting there = 1", files: "src/there.ts", root: there.dir });
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1 /);
  const job = text.split(" ")[1];
  // landing goes through git, so a developer's core.autocrlf may turn the line ending into CRLF
  expect(readFileSync(join(there.dir, "src", "there.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const there = 1;\n");
  expect(existsSync(join(here.dir, "src", "there.ts"))).toBe(false);
  expect(record(there.dir, job)).toMatchObject({ status: "OK", landed: true });
  expect(existsSync(join(here.dir, ".cheapag", "jobs", job))).toBe(false);
  expect(here.git("status", "--porcelain")).toBe("");

  expect((await callText(server.client, "jobs", { action: "list", root: there.dir })).split(" ")[1]).toBe(job);
  expect(await callText(server.client, "jobs", { action: "list" })).toBe("no jobs yet");
  expect(await callText(server.client, "jobs", { action: "show", job, root: there.dir })).toMatch(new RegExp(`^OK ${job} `));
  expect(await callText(server.client, "reply", { job, answer: "a", root: there.dir })).toBe(`FAIL reason: job ${job} is OK, not BLOCKED; only a BLOCKED job takes a reply`);
  expect(await callText(server.client, "reply", { job, answer: "a" })).toBe(`FAIL reason: no job ${job}; reply only to a BLOCKED job's id`);
  expect(await callText(server.client, "land", { job, action: "apply", root: there.dir })).toContain(job);
});

test("a root nobody allowed gets CONSENT, and no job starts there or in the cwd", async () => {
  const { here, fake, server } = await scenario([]);
  const other = tempRepo();
  onTestFinished(other.cleanup);
  const text = await callText(server.client, "delegate", { task: "Add src/x.ts", root: other.dir });
  expect(text).toMatch(new RegExp(`^CONSENT repo=${basename(other.dir)}`));
  expect(fake.recorded.prompts).toHaveLength(0);
  expect(existsSync(join(other.dir, ".cheapag", "jobs"))).toBe(false);
  expect(existsSync(join(here.dir, ".cheapag", "jobs"))).toBe(false);
  expect(await callText(server.client, "research", { question: "where is x?", root: other.dir })).toMatch(/^CONSENT /);
});

test("a relative root, or one outside any repository, fails before any job", async () => {
  const { fake, server } = await scenario([]);
  const outside = join(tmpdir(), `cheapag-no-repo-${process.pid}`);
  mkdirSync(outside, { recursive: true });
  onTestFinished(() => removeDir(outside));
  expect(await callText(server.client, "delegate", { task: "Add src/x.ts", root: "../elsewhere" })).toBe("FAIL reason: root ../elsewhere must be an absolute path");
  expect(await callText(server.client, "delegate", { task: "Add src/x.ts", root: outside })).toBe(`FAIL reason: ${outside} is not inside a git repository`);
  expect(await callText(server.client, "jobs", { action: "list", root: "rel" })).toBe("FAIL reason: root rel must be an absolute path");
  expect(await callText(server.client, "ping", { root: "rel" })).toBe("FAIL reason: root rel must be an absolute path");
  expect(fake.recorded.prompts).toHaveLength(0);
});

test("ping with root reports the repository calls with it work in", async () => {
  const { there, server } = await scenario([]);
  expect(await callText(server.client, "ping", { root: join(there.dir, "src", "..") })).toMatch(new RegExp(`^OK cheapag .* root=${there.dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`));
  expect(await callText(server.client, "ping")).not.toContain("root=");
});

test("a root's jobs left BLOCKED by a dead server are recovered on the first call with that root", async () => {
  const { there, server, env } = await scenario([{ edit: "src/there.ts", content: "export const there = 1;\n" }, DONE]);
  const job = (await callText(server.client, "delegate", { task: "Add src/there.ts", root: there.dir })).split(" ")[1];
  const stale = "jblkd";
  mkdirSync(join(there.dir, ".cheapag", "jobs", stale));
  const { pid: _, ...rest } = record(there.dir, job);
  writeFileSync(join(there.dir, ".cheapag", "jobs", stale, "result.json"), JSON.stringify({ ...rest, job: stale, status: "BLOCKED", landed: false }));

  // a fresh server started elsewhere has never seen `there`
  const next = await startServer({ cwd: server.home, env, logins: { "opencode-go": "k" } });
  onTestFinished(next.close);
  expect((await callText(next.client, "jobs", { action: "show", job: stale, root: there.dir })).split("\n")[0]).toMatch(new RegExp(`^CANCELLED ${stale} `));
  expect(record(there.dir, stale)).toMatchObject({ status: "CANCELLED", reason: "server restart" });
  expect(readdirSync(join(there.dir, ".cheapag", "jobs"))).toContain(job);
});
