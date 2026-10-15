import { existsSync, readFileSync } from "node:fs";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode } from "./fake-opencode.js";
import { callText, startServer, tempRepo } from "./harness.js";

// Self-tests drive the fake with the real pinned SDK client, so the fake cannot drift from what Cheap Agent sends.
async function setup() {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const client = createOpencodeClient({ baseUrl: fake.url, directory: repo.dir });
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  const events: Event[] = [];
  /** Reads the stream until an event of `type` arrives; returns it. */
  const until = async (type: string) => {
    for (;;) {
      const { value, done } = await stream.next();
      if (done) throw new Error(`stream ended before ${type}`);
      events.push(value as Event);
      if ((value as Event).type === type) return value as any;
    }
  };
  await until("server.connected");
  const session = (await client.session.create({ directory: repo.dir, agent: "cheapag-worker", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" }, permission: [{ permission: "*", pattern: "*", action: "deny" }] })).data!;
  const prompt = (model?: { providerID: string; modelID: string }) =>
    client.session.promptAsync({ sessionID: session.id, model, parts: [{ type: "text", text: "do step 1" }] });
  return { fake, repo, client, session, events, until, prompt };
}

test("health reports the pinned version by default, or a configured one", async () => {
  const pinned = await startFakeOpencode();
  const old = await startFakeOpencode({ version: "0.0.1" });
  onTestFinished(pinned.close);
  onTestFinished(old.close);
  expect((await createOpencodeClient({ baseUrl: pinned.url }).global.health()).data?.version).toBe("1.19.0");
  expect((await createOpencodeClient({ baseUrl: old.url }).global.health()).data?.version).toBe("0.0.1");
});

test("Cheap Agent boots against the fake through CHEAPAG_OPENCODE_URL", async () => {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({ env: { OPENCODE_GO_API_KEY: "k", CHEAPAG_OPENCODE_URL: fake.url } });
  onTestFinished(server.close);
  expect(await callText(server.client, "ping")).toMatch(/^OK cheapag \S+ opencode=1\.19\.0 /);
  expect(fake.recorded.requests.map((r) => r.path)).toEqual(["/global/health"]);
});

test("a scripted run edits files and emits turns, usage, text and finish in order, then goes idle", async () => {
  const { fake, repo, session, events, until, prompt } = await setup();
  expect(fake.recorded.sessions).toEqual([{
    id: session.id, directory: repo.dir, agent: "cheapag-worker",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" }, permission: [{ permission: "*", pattern: "*", action: "deny" }],
  }]);

  const report = { summary: "added hello", risks: ["none"], review: ["src/hello.ts:1-3"], missing: [] };
  fake.script(
    { edit: "src/hello.ts", content: "export const hello = 1;\n" },
    { tool: "edit", input: { filePath: "src/hello.ts" } },
    { usage: { cost: 0.002, input: 1000, output: 50 } },
    { usage: { cost: 0.001, input: 400, output: 20 } },
    { text: "```cheapag-result\nsummary: added hello\n```" },
    { finish: report },
  );
  await prompt();
  await until("session.idle");

  expect(readFileSync(`${repo.dir}/src/hello.ts`, "utf8")).toBe("export const hello = 1;\n");
  const seen = events.map((e) => e.type === "message.part.updated" ? `part:${(e.properties.part as any).tool ?? e.properties.part.type}` : e.type);
  expect(seen).toEqual(["server.connected", "session.status", "message.updated", "file.edited", "part:edit", "message.updated", "message.updated", "part:text", "part:finish", "session.status", "session.idle"]);
  // one assistant message per run: updates carry running totals, and every part hangs off it
  const updates = events.filter((e) => e.type === "message.updated").map((e) => (e.properties as any).info);
  expect(new Set(updates.map((m) => m.id)).size).toBe(1);
  expect(updates.at(-1)).toMatchObject({ role: "assistant", cost: 0.003, tokens: { input: 1400, output: 70 }, modelID: "deepseek-v4.1-flash" });
  const parts = events.filter((e) => e.type === "message.part.updated").map((e) => (e.properties as any).part);
  expect(parts.every((p) => p.messageID === updates[0].id)).toBe(true);
  expect(parts.find((p) => p.tool === "finish").state).toMatchObject({ status: "completed", input: report });
});

test("a question pauses the run until Cheap Agent replies; the reply is recorded and the script resumes", async () => {
  const { fake, repo, client, session, until, prompt } = await setup();
  fake.script({ question: "Which table?", options: ["users", "accounts"] }, { edit: "after.txt", content: "resumed\n" });
  await prompt();
  const asked = await until("question.asked");
  expect(asked.properties.questions[0]).toMatchObject({ question: "Which table?", options: [{ label: "users" }, { label: "accounts" }] });
  expect((await client.session.status({ directory: repo.dir })).data).toEqual({ [session.id]: { type: "busy" } });
  expect(existsSync(`${repo.dir}/after.txt`)).toBe(false);

  await client.question.reply({ requestID: asked.properties.id, answers: [["accounts"]] });
  await until("session.idle");
  expect(fake.recorded.questionReplies).toEqual([{ requestID: asked.properties.id, answers: [["accounts"]], rejected: false }]);
  expect(existsSync(`${repo.dir}/after.txt`)).toBe(true);
});

test("a rejected question also resumes the run, and is recorded as rejected", async () => {
  const { fake, client, until, prompt } = await setup();
  fake.script({ question: "Proceed?", options: ["yes", "no"] }, { tool: "read" });
  await prompt();
  const asked = await until("question.asked");
  await client.question.reject({ requestID: asked.properties.id });
  await until("question.rejected");
  await until("session.idle");
  expect(fake.recorded.questionReplies).toEqual([{ requestID: asked.properties.id, answers: undefined, rejected: true }]);
});

test("events and status are scoped to the session's directory", async () => {
  const { fake, client, session, until, prompt } = await setup();
  const elsewhere = tempRepo();
  onTestFinished(elsewhere.cleanup);
  const other = await client.event.subscribe({ directory: elsewhere.dir });
  expect((await other.stream.next()).value).toMatchObject({ type: "server.connected" });

  fake.script({ retry: { reason: "free_tier_limit", message: "limit" } });
  await prompt();
  await until("session.status");
  expect((await client.session.status({ directory: elsewhere.dir })).data).toEqual({});
  await client.session.abort({ sessionID: session.id });
  await until("session.idle");
  // nothing from the busy session reached the other directory's stream
  const next = await Promise.race([other.stream.next(), new Promise((r) => setTimeout(() => r("quiet"), 100))]);
  expect(next).toBe("quiet");
});

test("a permission request pauses until replied; the reject and its message are recorded", async () => {
  const { fake, client, until, prompt } = await setup();
  fake.script({ permission: "bash", patterns: ["npm install left-pad"] }, { tool: "read" });
  await prompt();
  const asked = await until("permission.asked");
  expect(asked.properties).toMatchObject({ permission: "bash", patterns: ["npm install left-pad"] });

  await client.permission.reply({ requestID: asked.properties.id, reply: "reject", message: "install commands are denied" });
  await until("session.idle");
  expect(fake.recorded.permissionReplies).toEqual([{ requestID: asked.properties.id, reply: "reject", message: "install commands are denied" }]);
});

test("a Go-limit retry hangs until abort; a continued prompt with a model override is recorded and used", async () => {
  const { fake, repo, client, session, until, prompt } = await setup();
  fake.script({ retry: { reason: "account_rate_limit", message: "Resets in 2h 14m" } });
  fake.script({ usage: { cost: 0.001 } });
  await prompt();

  const busy = await until("session.status");
  expect(busy.properties.status.type).toBe("busy");
  const limited = await until("session.status");
  expect(limited.properties.status).toMatchObject({ type: "retry", action: { reason: "account_rate_limit", message: "Resets in 2h 14m" } });
  expect((await client.session.status({ directory: repo.dir })).data?.[session.id]).toMatchObject({ type: "retry" });

  await client.session.abort({ sessionID: session.id });
  expect((await until("session.error")).properties.error.name).toBe("MessageAbortedError");
  await until("session.idle");
  expect(fake.recorded.aborts).toEqual([session.id]);

  const fallback = { providerID: "opencode-go", modelID: "qwen3.7-plus" };
  await prompt(fallback);
  await until("message.updated"); // the new run's assistant message, opened empty
  const usage = await until("message.updated");
  expect(usage.properties.info).toMatchObject({ providerID: "opencode-go", modelID: "qwen3.7-plus" });
  expect(fake.recorded.prompts.map((p) => p.model)).toEqual([undefined, fallback]);
});

test("a scripted error ends the run with session.error, then idle; unscripted prompts just go idle", async () => {
  const { fake, until, prompt } = await setup();
  fake.script({ error: { name: "APIError", message: "upstream 500" } });
  await prompt();
  expect((await until("session.error")).properties.error).toEqual({ name: "APIError", data: { message: "upstream 500" } });
  await until("session.idle");
  await prompt();
  await until("session.idle");
});
