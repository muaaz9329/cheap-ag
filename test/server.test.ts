import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, onTestFinished, test, vi } from "vitest";
import { callText, hermeticHome, serverEntry, slow, startServer, tempRepo } from "./harness.js";

const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;

/** The built server in `cwd` with its stderr captured (the harness's startServer inherits it). */
async function serverWithStderr(cwd: string, env: Record<string, string> = {}) {
  const home = hermeticHome({ "opencode-go": "k" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env: { ...home.env, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr!.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "cheapag-test", version: "0.0.0" });
  await client.connect(transport);
  onTestFinished(async () => {
    await client.close();
    rmSync(home.home, { recursive: true, force: true });
  });
  return { client, pid: transport.pid!, stderr: () => stderr };
}

test("research, reply and land refuse a root that is not an absolute path, as a FAIL block", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const server = await startServer({ cwd: repo.dir, logins: { "opencode-go": "k" } });
  onTestFinished(server.close);
  const fail = "FAIL reason: root rel must be an absolute path";
  expect(await callText(server.client, "research", { question: "q", root: "rel" })).toBe(fail);
  expect(await callText(server.client, "reply", { job: "j0000", answer: "a", root: "rel" })).toBe(
    fail,
  );
  expect(
    await callText(server.client, "land", { job: "j0000", action: "apply", root: "rel" }),
  ).toBe(fail);
});

// permission bits mean nothing to root or on Windows
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a failing job recovery at start is logged to stderr and the server still answers",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    const dir = join(repo.dir, ".cheapag", "jobs", "jdead");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const record = {
      format: "cheapag/1",
      job: "jdead",
      status: "RUNNING",
      landed: false,
      steps: "1",
      summary: "",
      changed: [],
      risks: [],
      review: [],
      missing: [],
      worktree: null,
      usage: { turns: 0, costUsd: 0 },
      selfFix: 0,
      models: { requested: "m", final: "m", escalated: false },
      pid: deadPid,
      timing: { startedAt: at, endedAt: null },
    };
    writeFileSync(join(dir, "result.json"), JSON.stringify(record));
    chmodSync(dir, 0o555); // the record cannot be rewritten
    onTestFinished(() => chmodSync(dir, 0o755));
    const server = await serverWithStderr(repo.dir);
    expect(await callText(server.client, "jobs", { action: "list" })).toContain("jdead");
    expect(server.stderr()).toMatch(/^cheapag: job recovery failed: .+\n/m);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).status).toBe("RUNNING"); // untouched
  },
);

test.skipIf(process.platform === "win32")(
  "a termination signal exits the server cleanly, tracing the shutdown when asked",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    const server = await serverWithStderr(repo.dir, { CHEAPAG_DEBUG_SHUTDOWN: "1" });
    process.kill(server.pid, "SIGTERM");
    await vi.waitFor(
      () =>
        expect(server.stderr()).toBe(
          "cheapag-shutdown: signal SIGTERM\ncheapag-shutdown: exit handler, stopping opencode\n",
        ),
      slow(5_000),
    );
  },
);
