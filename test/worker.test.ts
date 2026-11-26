import { createServer, type ServerResponse } from "node:http";
import { expect, onTestFinished, test, vi } from "vitest";
import { rejectionMessage } from "../src/permissions.js";
import { NO_SUMMARY } from "../src/report.js";
import { finishReport, openSession, type PermissionAsk } from "../src/worker.js";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { tempRepo } from "./harness.js";

type SessionOptions = Parameters<typeof openSession>[0];

/** A worker session on the fake OpenCode, opened directly (no job around it). */
async function session(
  script: Action[],
  onPermission: NonNullable<SessionOptions["onPermission"]>,
  signal?: AbortSignal,
  more: Partial<SessionOptions> = {},
) {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  fake.script(...script);
  const asked: string[] = []; // permission request ids, as the event stream showed them
  const s = await openSession({
    opencode: { url: fake.url, password: "unused", version: "" },
    directory: repo.dir,
    model: { providerID: "opencode-go", id: "m" },
    signal,
    onPermission,
    onEvent: (event) => void (event.type === "permission.asked" && asked.push(event.properties.id)),
    ...more,
  });
  /** Answers a pending permission request behind the worker's back, so its own answer finds nothing pending. */
  const answerFirst = (id: string) =>
    fetch(`${fake.url}/permission/${id}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": encodeURIComponent(repo.dir),
      },
      body: JSON.stringify({ reply: "once" }),
    });
  return { fake, s, asked, answerFirst };
}

const ask = (command: string): Action => ({ permission: "bash", command });

test("always allow: a later command with the same prefix is allowed without asking again; another prefix still asks", async () => {
  const onPermission = vi.fn(
    async (_ask: { command: string; prefix: string }) => "always" as const,
  );
  const { fake, s } = await session(
    [ask("git log -3"), ask("git log --oneline"), ask("git status"), { text: "done" }],
    onPermission,
  );
  const result = await s.run("go");
  expect(result).toMatchObject({ text: "done", error: undefined });
  // the prefix is the program plus a bare second word: "git log" covers both logs, and "git status" asks again
  expect(onPermission.mock.calls.map(([asked]) => [asked.command, asked.prefix])).toEqual([
    ["git log -3", "git log"],
    ["git status", "git status"],
  ]);
  expect(onPermission.mock.calls[0][0]).toMatchObject({ permission: "bash", always: false }); // git can write: never offered as "always"
  expect(fake.recorded.permissionReplies.map((r) => r.reply)).toEqual(["once", "once", "once"]);
  expect(s.totals().rejections).toEqual([]);
});

test("a session stopped while the user is being asked rejects the request with the usual message, and records no rejection", async () => {
  const stop = new AbortController();
  const onPermission = vi.fn(() => new Promise<never>(() => {})); // the user never answers
  const { fake, s } = await session([ask("rg foo"), { text: "never" }], onPermission, stop.signal);
  const running = s.run("go");
  await vi.waitFor(() => expect(onPermission).toHaveBeenCalled());
  stop.abort();
  expect((await running).error).toBeTruthy();
  expect(fake.recorded.permissionReplies).toMatchObject([
    { reply: "reject", message: rejectionMessage("*") },
  ]);
  expect(s.totals().rejections).toEqual([]);
});

test.each([
  ["once", /^could not answer a bash permission request: .*not pending/],
  ["reject", /^could not reject a bash permission request: .*not pending/],
] as const)(
  "an answer (%s) OpenCode does not accept ends the run with that error",
  async (answer, error) => {
    const ctx = await session([ask("rg foo"), { text: "done" }], async () => {
      await ctx.answerFirst(ctx.asked[0]);
      return answer;
    });
    expect((await ctx.s.run("go")).error).toMatch(error);
  },
);

/** Only the endpoints rotate() uses: create, fork and update. `fork` and `update` say what each answers. */
async function forkingServer(fork: object, updateStatus: number) {
  const requests: { method: string; path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, "http://x").pathname;
    requests.push({ method: req.method!, path, body: raw ? JSON.parse(raw) : undefined });
    const answer = (status: number, value: object) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (path === "/session") return answer(200, { id: "ses_first" });
    if (path.endsWith("/fork")) return answer(200, fork);
    return answer(
      updateStatus,
      updateStatus === 200 ? { id: "ses_fork" } : { name: "UnknownError", data: { message: "no" } },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const permission = [{ permission: "bash", pattern: "*", action: "deny" }] as never;
  const s = await openSession({
    opencode: { url, password: "unused", version: "" },
    directory: import.meta.dirname,
    model: { providerID: "opencode-go", id: "m" },
    permission,
    onEvent: () => {},
  });
  return { s, requests, permission };
}

test("rotate: a fork that kept the ruleset becomes the session as it is; one that lost it gets the ruleset re-applied first", async () => {
  const kept = await forkingServer(
    { id: "ses_fork", permission: [{ permission: "bash", pattern: "*", action: "deny" }] },
    200,
  );
  expect(await kept.s.rotate()).toBe(true);
  expect(kept.s.sessionID).toBe("ses_fork");
  expect(kept.requests.map((r) => r.path)).toEqual(["/session", "/session/ses_first/fork"]);

  const lost = await forkingServer({ id: "ses_fork" }, 200);
  expect(await lost.s.rotate()).toBe(true);
  expect(lost.s.sessionID).toBe("ses_fork");
  expect(lost.requests.at(-1)).toMatchObject({
    path: "/session/ses_fork",
    body: { permission: lost.permission },
  });
});

test("rotate: when the ruleset cannot be re-applied the session stays on the original, never on a looser fork", async () => {
  const { s, requests } = await forkingServer({ id: "ses_fork" }, 500);
  expect(await s.rotate()).toBe(false);
  expect(s.sessionID).toBe("ses_first");
  expect(requests.at(-1)?.path).toBe("/session/ses_fork");
});

/** Records every ask and allows it once. */
function allowOnce() {
  const asks: PermissionAsk[] = [];
  const onPermission = async (ask: PermissionAsk) => (asks.push(ask), "once" as const);
  return { asks, onPermission };
}

test("an ask without a description or step is titled by its program; its why is the asking message's text on one line, else its reasoning, else a placeholder", async () => {
  const { asks, onPermission } = allowOnce();
  const { s } = await session(
    [
      { text: "Look   at\n  the file" },
      ask("rg  -n foo"),
      { tool: "read" },
      { reasoning: "Thinking\tabout it" },
      ask("ls -la"),
      { tool: "read" },
      ask("pwd"),
      { text: "done" },
    ],
    onPermission,
  );
  await s.run("go");
  expect(asks).toEqual([
    {
      permission: "bash",
      command: "rg  -n foo",
      title: "rg",
      why: "Look at the file",
      prefix: "rg",
      always: true,
    },
    {
      permission: "bash",
      command: "ls -la",
      title: "ls",
      why: "Thinking about it",
      prefix: "ls",
      always: true,
    },
    {
      permission: "bash",
      command: "pwd",
      title: "pwd",
      why: "the worker gave no reason",
      prefix: "pwd",
      always: true,
    },
  ]);
});

test("an ask's title is its description as given, else it names the step (title trimmed, cut to 60); text beats reasoning and the why is cut to 200", async () => {
  const { asks, onPermission } = allowOnce();
  const long = "word ".repeat(60);
  const { s } = await session(
    [
      { reasoning: "the reasoning" },
      { text: long },
      { permission: "bash", command: "  rg x  ", description: "  Search for x " },
      { permission: "bash", command: "rg -n y", description: "   " },
    ],
    onPermission,
    undefined,
    { step: { label: "2", title: `  ${"t".repeat(70)} ` } },
  );
  await s.run("go");
  expect(asks.map(({ command, title, why }) => ({ command, title, why }))).toEqual([
    { command: "rg x", title: "  Search for x ", why: long.trim().slice(0, 200) },
    {
      command: "rg -n y",
      title: `rg for step 2: ${"t".repeat(60)}`,
      why: long.trim().slice(0, 200),
    },
  ]);
});

test("a tool call the ruleset denied is recorded with the command, path or input it targeted; other tool errors are not", async () => {
  const denied =
    "The user has specified a rule which prevents you from using this specific tool call.";
  const { s } = await session(
    [
      { tool: "bash", input: { command: "npm install zod" }, error: denied },
      { tool: "write", input: { filePath: "/x/y.ts", content: "x" }, error: denied },
      { tool: "webfetch", input: { format: "text" }, error: denied },
      { tool: "grep", input: { pattern: "p".repeat(250) }, error: denied },
      { tool: "bash", input: { command: "ls" }, error: "exit code 1" },
      { tool: "read", input: { filePath: "/x/z.ts" } },
    ],
    async () => "once",
  );
  await s.run("go");
  expect(s.totals()).toMatchObject({
    turns: 6,
    calls: 6,
    rejections: [
      { kind: "denied", permission: "bash", what: "npm install zod" },
      { kind: "denied", permission: "write", what: "/x/y.ts" },
      { kind: "denied", permission: "webfetch", what: '{"format":"text"}' },
      { kind: "denied", permission: "grep", what: "p".repeat(200) },
    ],
  });
});

test("the finish tool's report is read leniently: text from any value, a lone string as a list, repro and disagree trimmed or left out", async () => {
  const { s, fake } = await session(
    [
      {
        tool: "finish",
        input: {
          summary: 42,
          risks: "one risk",
          review: [1, "b"],
          missing: "",
          repro: "  npm test  ",
          disagree: "   ",
        },
      },
    ],
    async () => "once",
  );
  fake.script({ tool: "finish", input: { disagree: " spec says x " } });
  const first = await s.run("go");
  expect(first.finish).toStrictEqual({
    summary: "42",
    risks: ["one risk"],
    review: ["1", "b"],
    missing: [],
    repro: "npm test",
  });
  const second = await s.run("again");
  expect(second.finish).toStrictEqual({
    summary: "",
    risks: [],
    review: [],
    missing: [],
    disagree: "spec says x",
  });
});

test("finishReport: the finish tool's report as it is; else the last result block, parsed leniently; else a placeholder", () => {
  const finish = { summary: "s", risks: [], review: [], missing: [] };
  expect(finishReport({ finish, text: "```cheapag-result\nsummary: other\n```" })).toBe(finish);
  expect(finishReport({ text: "no block here" })).toStrictEqual({
    summary: NO_SUMMARY,
    risks: ["worker did not report; review diff"],
    review: [],
    missing: [],
  });
  const text = [
    "```cheapag-result",
    "summary: an earlier block",
    "```",
    "```cheapag-result  ",
    "risks: a,  b ,, c",
    "  - d  ",
    "-e",
    "summary:   done  ",
    "- not a risk",
    "review:",
    "- src/a.ts:1-2",
    "missing:  ",
    "note: ignored",
    "* not an item",
    "-   f",
    "repro:  npm test ",
    "disagree:",
    "```",
  ].join("\n");
  expect(finishReport({ text })).toStrictEqual({
    summary: "done",
    risks: ["a", "b", "c", "d"],
    review: ["src/a.ts:1-2"],
    missing: ["f"],
    repro: "npm test",
  });
  expect(finishReport({ text: "```cheapag-result\nrisks: r\n```" })).toStrictEqual({
    summary: NO_SUMMARY,
    risks: ["r"],
    review: [],
    missing: [],
  });
});

test("questions with nowhere to go are rejected and recorded as one rejection", async () => {
  const { s, fake } = await session(
    [
      {
        questions: [
          { question: "A?", options: ["x"] },
          { question: "B?", options: ["y"] },
        ],
      },
      { text: "done" },
    ],
    async () => "once",
  );
  expect(await s.run("go")).toStrictEqual({ finish: undefined, text: "done", error: undefined });
  expect(fake.recorded.questionReplies).toMatchObject([{ rejected: true }]);
  expect(s.totals().rejections).toEqual([
    { kind: "asked", permission: "question", what: "A? / B?" },
  ]);
});

test("an interrupted prompt returns what it had, marked interrupted; a stopped session refuses a new prompt", async () => {
  const interrupt = new AbortController();
  const stop = new AbortController();
  const { s, fake } = await session(
    [{ text: "partial" }, { hook: () => interrupt.abort() }, { wait: 60_000 }],
    async () => "once",
    stop.signal,
  );
  expect(await s.run("go", undefined, interrupt.signal)).toStrictEqual({
    finish: undefined,
    text: "partial",
    interrupted: true,
  });
  expect(fake.recorded.aborts).toHaveLength(1);
  stop.abort();
  expect(await s.run("again")).toStrictEqual({ text: "", error: "aborted" });
});

test("a provider error ends the run with its message and HTTP status; one only on the assistant message too", async () => {
  const { s, fake } = await session(
    [{ error: { name: "APIError", message: "Insufficient credits", statusCode: 402 } }],
    async () => "once",
  );
  fake.script({ error: { name: "APIError", message: "upstream 500" }, on: "message" });
  expect(await s.run("go")).toStrictEqual({
    finish: undefined,
    text: "",
    error: "Insufficient credits",
    httpStatus: 402,
  });
  expect(await s.run("again")).toStrictEqual({
    finish: undefined,
    text: "",
    error: "upstream 500",
  });
});

test("a short transient retry is left to OpenCode; a limit retry stops the run with the limit", async () => {
  const next = Date.now() + 3_600_000;
  const { s, fake } = await session(
    [
      { retry: { message: "Overloaded", next: Date.now() + 2_000, recoverAfter: 50 } },
      { text: "still going" },
      { retry: { reason: "free_tier_limit", message: "Resets in 5h", next } },
    ],
    async () => "once",
  );
  const result = await s.run("go");
  expect(result).toMatchObject({
    text: "still going",
    limit: { model: "opencode-go/m", reason: "free_tier_limit", message: "Resets in 5h", next },
  });
  expect(Object.keys(result)).toEqual(["finish", "text", "error", "limit"]);
  expect(fake.recorded.aborts).toHaveLength(1);
});

test("totals add up every message's usage, with the cost per model", async () => {
  const { s, fake } = await session(
    [
      { usage: { cost: 0.01, input: 100, output: 10, reasoning: 5 } },
      { tool: "read" },
      { usage: { cost: 0.02, input: 200 } },
    ],
    async () => "once",
  );
  fake.script({ usage: { cost: 0.5, output: 7 } });
  await s.run("go");
  await s.run("again", { providerID: "opencode-go", id: "n" });
  expect(s.totals()).toStrictEqual({
    sessionID: s.sessionID,
    turns: 1,
    calls: 1,
    usage: {
      inputTokens: 300,
      outputTokens: 17,
      reasoningTokens: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.53,
    },
    rejections: [],
    spend: { "opencode-go/m": 0.03, "opencode-go/n": 0.5 },
  });
});

/**
 * A hand-written OpenCode for what the fake cannot script: after the prompt it sends `events` (each tagged with the
 * session), then goes idle. `fail` makes session creation or the prompt answer with an error.
 */
async function stubOpencode(
  events: [type: string, properties: object][],
  fail: { session?: boolean; prompt?: boolean } = {},
) {
  let stream: ServerResponse | undefined;
  const send = (type: string, properties: object) =>
    stream?.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
  const error = { name: "UnknownError", data: { message: "no" } };
  const server = createServer(async (req, res) => {
    for await (const _chunk of req); // drain the body
    const path = new URL(req.url!, "http://x").pathname;
    const answer = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (path === "/session")
      return fail.session ? answer(500, error) : answer(200, { id: "ses_stub" });
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      stream = res;
      return void send("server.connected", {});
    }
    if (!path.endsWith("/prompt_async")) return answer(200, true);
    if (fail.prompt) return answer(500, error);
    res.writeHead(204).end();
    for (const [type, properties] of events) send(type, { sessionID: "ses_stub", ...properties });
    send("session.idle", { sessionID: "ses_stub" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void (server.closeAllConnections(), server.close()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { opencode: { url, password: "unused", version: "" }, directory: import.meta.dirname };
}

const stubModel = { providerID: "opencode-go", id: "m" };

test("a session OpenCode will not create, or a prompt it will not take, throws with OpenCode's error", async () => {
  const refused = await stubOpencode([], { session: true });
  const created = await openSession({ ...refused, model: stubModel, onEvent: () => {} }).catch(
    (error: Error) => error,
  );
  expect((created as Error).message).toBe(
    'could not create a worker session: {"name":"UnknownError","data":{"message":"no"}}',
  );
  const s = await openSession({
    ...(await stubOpencode([], { prompt: true })),
    model: stubModel,
    onEvent: () => {},
  });
  const prompted = await s.run("go").catch((error: Error) => error);
  expect((prompted as Error).message).toBe(
    'could not prompt the worker: {"name":"UnknownError","data":{"message":"no"}}',
  );
});

test("a bash call's own description titles its ask over the request's; a denied call seen twice is one rejection; an error with no message is unknown", async () => {
  const deniedPart = {
    type: "tool",
    id: "prt_2",
    callID: "call_2",
    messageID: "msg_1",
    tool: "bash",
    state: {
      status: "error",
      input: { command: "npm i zod" },
      error: "The user has specified a rule which prevents you from using this specific tool call.",
    },
  };
  const opencode = await stubOpencode([
    [
      "message.part.updated",
      {
        part: {
          type: "tool",
          id: "prt_1",
          callID: "call_1",
          messageID: "msg_1",
          tool: "bash",
          state: { status: "running", input: { command: "rg foo", description: "Search for foo" } },
        },
      },
    ],
    [
      "permission.asked",
      {
        id: "per_1",
        permission: "bash",
        patterns: ["rg foo"],
        metadata: { command: "rg foo", description: "from the request" },
        always: [],
        tool: { messageID: "msg_1", callID: "call_1" },
      },
    ],
    ["message.part.updated", { part: deniedPart }],
    ["message.part.updated", { part: deniedPart }],
    ["session.error", { error: {} }],
  ]);
  const { asks, onPermission } = allowOnce();
  const s = await openSession({ ...opencode, model: stubModel, onPermission, onEvent: () => {} });
  expect((await s.run("go")).error).toBe("unknown worker error");
  expect(asks.map((a) => a.title)).toEqual(["Search for foo"]);
  expect(s.totals()).toMatchObject({
    calls: 1,
    rejections: [{ kind: "denied", permission: "bash", what: "npm i zod" }],
  });
});
