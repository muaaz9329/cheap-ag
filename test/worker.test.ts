import { createServer } from "node:http";
import { expect, onTestFinished, test, vi } from "vitest";
import { rejectionMessage } from "../src/permissions.js";
import { openSession } from "../src/worker.js";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { tempRepo } from "./harness.js";

/** A worker session on the fake OpenCode, opened directly (no job around it). */
async function session(
  script: Action[],
  onPermission: NonNullable<Parameters<typeof openSession>[0]["onPermission"]>,
  signal?: AbortSignal,
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
