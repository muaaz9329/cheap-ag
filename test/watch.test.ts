import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { scan, toolTarget, watchState } from "../src/watch.js";

test("toolTarget: the file a tool touched, a bash command's first line, nothing for other tools", () => {
  const base = join(tmpdir(), "cheapag-watch-base");
  expect(toolTarget("edit", { filePath: join(base, "src", "foo.ts") }, base)).toBe(join("src", "foo.ts"));
  expect(toolTarget("write", { filePath: "src/foo.ts" }, base)).toBe("src/foo.ts"); // already relative
  expect(toolTarget("read", { filePath: join(base, "README.md") }, base)).toBe("README.md");
  const command = "x".repeat(60) + "\nignored second line";
  expect(toolTarget("bash", { command })).toBe("x".repeat(40));
  expect(toolTarget("bash", { command: "npm test -- cart" })).toBe("npm test -- cart");
  expect(toolTarget("grep", { pattern: "foo" })).toBe("");
  expect(toolTarget("edit", undefined)).toBe("");
  expect(toolTarget("bash", null)).toBe("");
});

test("scan: a job finished before watch is skipped; new events and the verdict print once", () => {
  const root = mkdtempSync(join(tmpdir(), "cheapag-watch-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const jobs = join(root, ".cheapag", "jobs");
  mkdirSync(join(jobs, "jdone"), { recursive: true });
  writeFileSync(join(jobs, "jdone", "result.txt"), "OK jdone step=1\n");
  const dir = join(jobs, "j1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.json"), JSON.stringify({ steps: "1", model: "openrouter/deepseek/deepseek-v4.1-flash" }));
  // a freshly created job already has a result.txt, still RUNNING: it must not count as finished
  writeFileSync(join(dir, "result.txt"), "RUNNING j1 step=1 turns=0 cost=$0.000\n");

  const edit = {
    id: "evt_1", type: "message.part.updated",
    properties: { sessionID: "ses_1", time: 1, part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "call_1", tool: "edit", state: { status: "completed", input: { filePath: "src/foo.ts" }, output: "", title: "edit", metadata: {}, time: { start: 1, end: 2 } } } },
  };
  const assistant = {
    id: "evt_2", type: "message.updated",
    properties: { sessionID: "ses_1", time: 2, info: { id: "msg_1", role: "assistant", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
  };
  const bash = {
    id: "evt_3", type: "message.part.updated",
    properties: { sessionID: "ses_1", time: 3, part: { id: "prt_2", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "call_2", tool: "bash", state: { status: "completed", input: { command: "npm test -- cart", description: "run the tests" }, output: "", title: "bash", metadata: {}, time: { start: 3, end: 4 } } } },
  };
  const bashLine = JSON.stringify(bash);
  const cut = 30;
  writeFileSync(join(dir, "events.jsonl"), [JSON.stringify(edit), JSON.stringify(assistant), bashLine.slice(0, cut)].join("\n"));

  const state = watchState(root);
  expect(scan(state)).toEqual(["▶ j1 · steps 1 · deepseek-v4.1-flash", "  j1  edit src/foo.ts"]);

  appendFileSync(join(dir, "events.jsonl"), bashLine.slice(cut) + "\n");
  writeFileSync(join(dir, "result.txt"), "OK j1 step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000\nsummary: done\n");
  expect(scan(state)).toEqual(["  j1  bash npm test -- cart", "■ j1 OK j1 step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000"]);

  expect(scan(state)).toEqual([]);
});
