import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
import { follow, scan, toolTarget, watch, watchState } from "../src/watch.js";
import { serverEntry, slow, tempRepo } from "./harness.js";

test("toolTarget: the file a tool touched, a bash command's first line, nothing for other tools", () => {
  const base = join(tmpdir(), "cheapag-watch-base");
  expect(toolTarget("edit", { filePath: join(base, "src", "foo.ts") }, base)).toBe(
    join("src", "foo.ts"),
  );
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
  writeFileSync(
    join(dir, "request.json"),
    JSON.stringify({ steps: "1", model: "openrouter/deepseek/deepseek-v4.1-flash" }),
  );
  // a freshly created job already has a result.txt, still RUNNING: it must not count as finished
  writeFileSync(join(dir, "result.txt"), "RUNNING j1 step=1 turns=0 cost=$0.000\n");

  const edit = {
    id: "evt_1",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      time: 1,
      part: {
        id: "prt_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "call_1",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "src/foo.ts" },
          output: "",
          title: "edit",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    },
  };
  const assistant = {
    id: "evt_2",
    type: "message.updated",
    properties: {
      sessionID: "ses_1",
      time: 2,
      info: {
        id: "msg_1",
        role: "assistant",
        cost: 0.001,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  };
  const bash = {
    id: "evt_3",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      time: 3,
      part: {
        id: "prt_2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "call_2",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test -- cart", description: "run the tests" },
          output: "",
          title: "bash",
          metadata: {},
          time: { start: 3, end: 4 },
        },
      },
    },
  };
  const bashLine = JSON.stringify(bash);
  const cut = 30;
  writeFileSync(
    join(dir, "events.jsonl"),
    [JSON.stringify(edit), JSON.stringify(assistant), bashLine.slice(0, cut)].join("\n"),
  );

  const state = watchState(root);
  expect(scan(state)).toEqual(["▶ j1 · steps 1 · deepseek-v4.1-flash", "  j1  edit src/foo.ts"]);

  appendFileSync(join(dir, "events.jsonl"), bashLine.slice(cut) + "\n");
  writeFileSync(
    join(dir, "result.txt"),
    "OK j1 step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000\nsummary: done\n",
  );
  expect(scan(state)).toEqual([
    "  j1  bash npm test -- cart",
    "■ j1 OK j1 step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000",
  ]);

  expect(scan(state)).toEqual([]);
});

test("follow: prints each progress change once, then the result blocks, and resolves 0 when every job is final", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheapag-follow-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const jobs = join(root, ".cheapag", "jobs");
  const j1 = join(jobs, "j1");
  const j2 = join(jobs, "j2");
  mkdirSync(j1, { recursive: true });
  mkdirSync(j2, { recursive: true });
  writeFileSync(join(j1, "progress.txt"), "step 1 · turn 1 · read a.ts · 1s\n");
  writeFileSync(join(j1, "result.txt"), "RUNNING j1 …\n");
  writeFileSync(join(j2, "result.txt"), "OK j2 step=2 …\nsummary: x\n");

  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  const done = follow(root, ["j1", "j2"], sink, 10);
  await vi.waitFor(() => expect(text).toContain("turn 1"));
  writeFileSync(join(j1, "progress.txt"), "step 1 · turn 2 · edit a.ts · 2s\n");
  await vi.waitFor(() => expect(text).toContain("turn 2"));
  writeFileSync(join(j1, "result.txt"), "OK j1 step=1 …\nsummary: y\n");
  expect(await done).toBe(0);

  expect(text.match(/^  j1  step 1 · turn 1 · read a\.ts · 1s$/gm)).toHaveLength(1);
  expect(text.match(/^  j1  step 1 · turn 2 · edit a\.ts · 2s$/gm)).toHaveLength(1);
  expect(text).toContain("\nOK j2 step=2 …\nsummary: x\n");
  expect(text).toContain("\nOK j1 step=1 …\nsummary: y\n");

  const p1 = text.indexOf("  j1  step 1 · turn 1");
  const p2 = text.indexOf("  j1  step 1 · turn 2");
  const r2 = text.indexOf("OK j2 step=2");
  const r1 = text.indexOf("OK j1 step=1");
  expect(p1).toBeGreaterThanOrEqual(0);
  expect(p2).toBeGreaterThan(p1);
  expect(r2).toBeGreaterThanOrEqual(0);
  expect(r1).toBeGreaterThan(p2);
  expect(r2).toBeLessThan(r1);
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("watching");
});

test("follow: a missing job folder prints once and counts as final", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheapag-follow-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  expect(await follow(root, ["jzzzz"], sink, 10)).toBe(0);
  expect(text).toBe("✗ no job jzzzz\n");
});

test("scan: odd job folders never throw: a dangling link, no request.json, an unreadable result, a damaged event line", () => {
  const root = mkdtempSync(join(tmpdir(), "cheapag-watch-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const jobs = join(root, ".cheapag", "jobs");
  const dir = join(jobs, "j1");
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(jobs, "nowhere"), join(jobs, "jlink")); // dangling: cannot be examined
  mkdirSync(join(dir, "result.txt")); // a folder where the result file belongs: unreadable
  writeFileSync(
    join(dir, "events.jsonl"),
    "{ damaged\n" +
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "ls" } },
          },
        },
      }) +
      "\n",
  );
  const state = watchState(root);
  expect(scan(state)).toEqual(["▶ j1", "  j1  bash ls"]); // no request.json: the id alone; no verdict
  expect(scan(state)).toEqual([]);
});

test("follow: an unreadable progress file prints nothing and the job still ends on its result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cheapag-follow-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".cheapag", "jobs", "j1");
  mkdirSync(join(dir, "progress.txt"), { recursive: true }); // a folder: unreadable as a file
  writeFileSync(join(dir, "result.txt"), "OK j1 step=1\n");
  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  expect(await follow(root, ["j1"], sink, 10)).toBe(0);
  expect(text).toBe("\nOK j1 step=1\n");
});

test(
  "cheapag watch: tails the repo's jobs until stopped; with job ids it follows them and exits 0; outside a repo it exits 1",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    const child = spawn(process.execPath, [serverEntry, "watch"], { cwd: repo.dir });
    onTestFinished(() => void child.kill());
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    await vi.waitFor(
      () => expect(out).toBe(`watching ${join(repo.dir, ".cheapag", "jobs")} (Ctrl-C to stop)\n`),
      slow(10_000),
    );
    const dir = join(repo.dir, ".cheapag", "jobs", "jab12");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.txt"), "RUNNING jab12\n");
    await vi.waitFor(() => expect(out).toContain("▶ jab12\n"), slow(10_000));
    writeFileSync(join(dir, "result.txt"), "OK jab12 step=1\n");
    await vi.waitFor(
      () => expect(out).toContain("▶ jab12\n■ jab12 OK jab12 step=1\n"),
      slow(10_000),
    );
    expect(child.exitCode).toBeNull(); // still watching

    const followed = spawnSync(
      process.execPath,
      [serverEntry, "watch", "jab12", "jnone", "--ignored-flag"],
      { cwd: repo.dir, encoding: "utf8" },
    );
    expect(followed.status).toBe(0);
    expect(followed.stdout).toBe("\nOK jab12 step=1\n✗ no job jnone\n");

    const outside = spawnSync(process.execPath, [serverEntry, "watch"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(outside.status).toBe(1);
    expect(outside.stdout).toMatch(/^✗ .+\n$/);
  },
  slow(30_000),
);

/** A temporary project root, removed when the test ends. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cheapag-watch-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A stream that collects everything written to it. */
function textSink(): { sink: Writable; text: () => string } {
  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { sink, text: () => text };
}

/** One events.jsonl line for a tool part, with optional fields beside the part and on the event. */
function toolEventLine(
  part: Record<string, unknown>,
  properties: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "message.part.updated",
    properties: { part: { type: "tool", ...part }, ...properties },
    ...event,
  });
}

test("toolTarget: an empty or missing base, a path that only shares the base's prefix, non-string fields, a CRLF command", () => {
  const base = join(tmpdir(), "cheapag-watch-base");
  const inside = join(base, "a.ts");
  const sibling = base + "x" + sep + "a.ts";
  expect(toolTarget("edit", { filePath: inside }, "")).toBe(inside);
  expect(toolTarget("edit", { filePath: inside })).toBe(inside);
  expect(toolTarget("edit", { filePath: sibling }, base)).toBe(sibling);
  expect(toolTarget("edit", { filePath: base }, base)).toBe(base);
  expect(toolTarget("read", { filePath: 42 }, base)).toBe("");
  expect(toolTarget("bash", { command: 7 })).toBe("");
  expect(toolTarget("bash", "ls")).toBe("");
  expect(toolTarget("bash", { command: "npm test\r\nsecond" })).toBe("npm test");
  expect(toolTarget("bash", { command: "" })).toBe("");
});

test("scan: no jobs folder gives nothing; jobs print in name order; the ▶ line takes steps and the model's last segment", () => {
  const root = tempRoot();
  const state = watchState(root);
  expect(scan(state)).toEqual([]);
  const jobs = join(root, ".cheapag", "jobs");
  mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, "a-file"), "not a job folder");
  const requests: Record<string, string> = {
    j6: JSON.stringify({ steps: "1-2,3", model: "a/b/" }),
    j5: JSON.stringify("text"),
    j4: "null",
    j3: JSON.stringify({ model: 42 }),
    j2: JSON.stringify({ steps: null, model: "" }),
    j1: JSON.stringify({ steps: 2, model: "plain-model" }),
  };
  for (const [id, request] of Object.entries(requests)) {
    mkdirSync(join(jobs, id));
    writeFileSync(join(jobs, id, "request.json"), request);
  }
  mkdirSync(join(jobs, "j10"));
  expect(scan(state)).toEqual([
    "▶ j1 · steps 2 · plain-model",
    "▶ j10",
    "▶ j2 · steps null",
    "▶ j3",
    "▶ j4",
    "▶ j5",
    "▶ j6 · steps 1-2,3",
  ]);
  expect(scan(state)).toEqual([]);
});

test("scan: a BLOCKED job is live, a job final at first sight stays hidden, and the verdict is the trimmed first line", () => {
  const root = tempRoot();
  const jobs = join(root, ".cheapag", "jobs");
  const blocked = join(jobs, "jblocked");
  const done = join(jobs, "jdone");
  const spaced = join(jobs, "jspaced");
  for (const dir of [blocked, done, spaced]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(blocked, "result.txt"), "BLOCKED jblocked ask\n");
  writeFileSync(join(done, "result.txt"), "FAIL jdone\n");
  writeFileSync(join(spaced, "result.txt"), "  OK jspaced\n"); // no first word: never final

  const state = watchState(root);
  expect(scan(state)).toEqual(["▶ jblocked", "▶ jspaced"]);
  expect(JSON.stringify([...state.jobs])).toBe(
    JSON.stringify([
      [blocked, { offset: 0, started: true, verdict: false, skipped: false }],
      [done, { offset: 0, started: true, verdict: true, skipped: true }],
      [spaced, { offset: 0, started: true, verdict: false, skipped: false }],
    ]),
  );

  const bash = { tool: "bash", state: { status: "completed", input: { command: "ls" } } };
  appendFileSync(join(done, "events.jsonl"), toolEventLine(bash) + "\n");
  writeFileSync(join(done, "result.txt"), "RUNNING jdone\n");
  writeFileSync(join(blocked, "result.txt"), "OK jblocked step=1  \r\nsummary: x\n");
  writeFileSync(join(spaced, "result.txt"), "OK jspaced");
  expect(scan(state)).toEqual(["■ jblocked OK jblocked step=1", "■ jspaced OK jspaced"]);
  writeFileSync(join(done, "result.txt"), "OK jdone\n");
  expect(scan(state)).toEqual([]);
});

test("scan: only finished tool parts print, errors get ✗, and the byte offset survives multi-byte text", () => {
  const root = tempRoot();
  const dir = join(root, ".cheapag", "jobs", "j1");
  mkdirSync(dir, { recursive: true });
  const events = join(dir, "events.jsonl");
  const complete = [
    toolEventLine({ tool: "read", state: { status: "error", input: { filePath: "é/ü.ts" } } }),
    "",
    "null",
    toolEventLine({ tool: "edit", state: { status: "running", input: { filePath: "a.ts" } } }),
    JSON.stringify({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "✗✗" } },
    }),
    JSON.stringify({
      type: "message.updated",
      properties: { part: { type: "tool", tool: "bash", state: { status: "completed" } } },
    }),
    toolEventLine({ state: { status: "completed" } }),
    toolEventLine({ tool: "grep", state: { status: "completed", input: { pattern: "x" } } }) + "\r",
  ];
  const write = { tool: "write", state: { status: "completed", input: { filePath: "ß.ts" } } };
  const partial = Buffer.from(toolEventLine(write) + "\n");
  const cut = partial.indexOf(Buffer.from("ß")) + 1; // inside the two bytes of ß
  writeFileSync(
    events,
    Buffer.concat([Buffer.from(complete.join("\n") + "\n"), partial.subarray(0, cut)]),
  );

  const state = watchState(root);
  expect(scan(state)).toEqual(["▶ j1", "  j1  read é/ü.ts ✗", "  j1  ", "  j1  grep"]);
  appendFileSync(events, partial.subarray(cut));
  expect(scan(state)).toEqual(["  j1  write ß.ts"]);
  expect(state.jobs.get(dir)?.offset).toBe(readFileSync(events).length);
  expect(scan(state)).toEqual([]);
});

test("scan: a tool's path is shown relative to the part's directory, else the event's, else the job's worktree", () => {
  const root = tempRoot();
  const dir = join(root, ".cheapag", "jobs", "j1");
  mkdirSync(dir, { recursive: true });
  const tree = join(root, ".cheapag", "worktrees", "j1");
  const [a, b, c] = [join(root, "a"), join(root, "b"), join(root, "c")];
  const edit = (filePath: string) => ({
    tool: "edit",
    state: { status: "completed", input: { filePath } },
  });
  const lines = [
    toolEventLine({ ...edit(join(a, "1.ts")), directory: a }, { directory: b }, { directory: c }),
    toolEventLine({ ...edit(join(b, "2.ts")), directory: "" }, { directory: b }, { directory: c }),
    toolEventLine({ ...edit(join(c, "3.ts")), directory: 5 }, { directory: 6 }, { directory: c }),
    toolEventLine(edit(join(tree, "4.ts"))),
    toolEventLine(edit(join(a, "5.ts")), { directory: b }),
  ];
  writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
  expect(scan(watchState(root))).toEqual([
    "▶ j1",
    "  j1  edit 1.ts",
    "  j1  edit 2.ts",
    "  j1  edit 3.ts",
    "  j1  edit 4.ts",
    `  j1  edit ${join(a, "5.ts")}`,
  ]);
});

test("follow: BLOCKED ends a job too, blank progress prints nothing, results follow the ids' order, no ids resolves at once", async () => {
  const root = tempRoot();
  const jobs = join(root, ".cheapag", "jobs");
  mkdirSync(join(jobs, "ja"), { recursive: true });
  mkdirSync(join(jobs, "jb"), { recursive: true });
  writeFileSync(join(jobs, "jb", "progress.txt"), "  \n");
  writeFileSync(join(jobs, "jb", "result.txt"), "BLOCKED jb ask\n\n");
  writeFileSync(join(jobs, "ja", "result.txt"), "OK ja\n");
  const { sink, text } = textSink();
  expect(await follow(root, ["jb", "ja"], sink, 10)).toBe(0);
  expect(text()).toBe("\nBLOCKED jb ask\n\nOK ja\n");
  expect(await follow(root, [], sink, 10)).toBe(0);
  expect(text()).toBe("\nBLOCKED jb ask\n\nOK ja\n");
});

test("follow: reads once at the start, then every pollMs (500 by default), and stops without another wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => void vi.useRealTimers());
  const root = tempRoot();
  const dir = join(root, ".cheapag", "jobs", "j1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "progress.txt"), "turn 1\n");
  writeFileSync(join(dir, "result.txt"), "RUNNING j1\n");
  const { sink, text } = textSink();

  const done = follow(root, ["j1"], sink);
  expect(text()).toBe("  j1  turn 1\n");
  writeFileSync(join(dir, "progress.txt"), "turn 2\n");
  await vi.advanceTimersByTimeAsync(499);
  expect(text()).toBe("  j1  turn 1\n");
  await vi.advanceTimersByTimeAsync(1);
  expect(text()).toBe("  j1  turn 1\n  j1  turn 2\n");
  writeFileSync(join(dir, "result.txt"), "OK j1\n");
  await vi.advanceTimersByTimeAsync(500);
  expect(await done).toBe(0);
  expect(text()).toBe("  j1  turn 1\n  j1  turn 2\n\nOK j1\n");
  expect(vi.getTimerCount()).toBe(0);
});

test("watch: prints the header and each scan's lines, scanning at once and then every pollMs (500 by default)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => void vi.useRealTimers());
  const root = tempRoot();
  const dir = join(root, ".cheapag", "jobs", "j1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.txt"), "RUNNING j1\n");
  const { sink, text } = textSink();
  const header = `watching ${join(root, ".cheapag", "jobs")} (Ctrl-C to stop)\n`;

  void watch(root, sink);
  expect(text()).toBe(`${header}▶ j1\n`);
  writeFileSync(join(dir, "result.txt"), "OK j1 step=1\n");
  await vi.advanceTimersByTimeAsync(499);
  expect(text()).toBe(`${header}▶ j1\n`);
  await vi.advanceTimersByTimeAsync(1);
  expect(text()).toBe(`${header}▶ j1\n■ j1 OK j1 step=1\n`);
  expect(vi.getTimerCount()).toBe(1);
});
