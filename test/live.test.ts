import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { expect, onTestFinished, test } from "vitest";
import { opencodeBinary } from "../src/opencode.js";
import { callText, startServer, tempRepo } from "./harness.js";

/**
 * Opt-in live checks against the real bundled OpenCode and a real model. They cost money:
 *   CHEAPAG_LIVE=1 OPENROUTER_API_KEY=… npm test -- test/live.test.ts
 * Each prints what it observed and spent, for the ticket ledger.
 */
const key = process.env.OPENROUTER_API_KEY;
const live = test.skipIf(!process.env.CHEAPAG_LIVE || !key);

live("a one-step delegate on OpenRouter lands OK, uncommitted", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "live.md"), [
    "# Live smoke",
    "## 1 greeting file",
    "files: hello.txt",
    "do: create hello.txt containing exactly the line: hello from cheapag",
    "done-when: hello.txt exists with that line",
    "",
  ].join("\n"));
  const server = await startServer({ cwd: repo.dir, env: { OPENROUTER_API_KEY: key! } });
  onTestFinished(server.close);

  const progress: string[] = [];
  const result = await server.client.callTool({ name: "delegate", arguments: { plan: ".plan/live.md", steps: "1" } }, undefined, {
    onprogress: (p) => void progress.push(p.message ?? ""),
    timeout: 300_000,
  });
  const text = (result.content as { text: string }[])[0].text;
  console.log(`LIVE delegate block:\n${text}\nprogress: ${JSON.stringify(progress)}`);
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1 /);
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8").trim()).toBe("hello from cheapag");
  expect(repo.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  expect(repo.git("status", "--porcelain", "--", "hello.txt")).toBe("?? hello.txt\n");

  // protocol facts ticket 03 inferred from the SDK types, as observed on the real server
  const job = text.match(/^OK (j[0-9a-z]{4})/)![1];
  const events = readFileSync(join(repo.dir, ".cheapag", "jobs", job, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event);
  const costs = new Map<string, number[]>();
  for (const e of events) if (e.type === "message.updated" && e.properties.info.role === "assistant") costs.set(e.properties.info.id, [...(costs.get(e.properties.info.id) ?? []), e.properties.info.cost]);
  const finish = events.find((e) => e.type === "message.part.updated" && e.properties.part.type === "tool" && e.properties.part.tool === "finish" && e.properties.part.state.status === "completed");
  console.log(`LIVE message.updated cost series per assistant message: ${JSON.stringify([...costs.values()])}`);
  console.log(`LIVE finish part state.input: ${JSON.stringify(finish && (finish.properties as any).part.state.input)}`);
  console.log(`LIVE event types: ${JSON.stringify([...new Set(events.map((e) => e.type))])}`);
}, 300_000);

live("abort on a real session: observed event sequence", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const server = await startServer({ cwd: repo.dir, env: { OPENROUTER_API_KEY: key! } });
  onTestFinished(server.close);
  expect(await callText(server.client, "ping")).toMatch(/^OK .* provider=openrouter via=OPENROUTER_API_KEY$/);

  // a second, test-owned OpenCode on the config ping just generated, so the test holds the password
  const opencode = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    env: { ...process.env, OPENROUTER_API_KEY: key, OPENCODE_SERVER_PASSWORD: "live", OPENCODE_CONFIG_DIR: join(repo.dir, ".cheapag", "opencode"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  });
  onTestFinished(() => {
    try {
      process.kill(-opencode.pid!);
    } catch {
      // already gone
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    opencode.stdout.on("data", (d) => {
      const m = String(d).match(/(http:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    opencode.on("error", reject);
    opencode.on("exit", (code) => reject(new Error(`opencode serve exited (${code}) before listening`)));
  });
  const client = createOpencodeClient({ baseUrl: url, directory: repo.dir, headers: { authorization: `Basic ${Buffer.from("opencode:live").toString("base64")}` } });
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  await stream.next();
  const session = (await client.session.create({ directory: repo.dir, agent: "cheapag-worker", model: { providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" } })).data!;
  await client.session.promptAsync({ sessionID: session.id, directory: repo.dir, parts: [{ type: "text", text: "Write a 400-word story about a lighthouse. Do not use tools." }] });

  const seen: string[] = [];
  let aborted = false;
  for await (const raw of stream) {
    const e = raw as Event;
    if ((e.properties as { sessionID?: string }).sessionID !== session.id) continue;
    seen.push(e.type === "session.status" ? `session.status:${e.properties.status.type}` : e.type === "session.error" ? `session.error:${(e.properties.error as any)?.name}` : e.type);
    if (!aborted && e.type === "message.part.updated") {
      aborted = true;
      seen.push("--abort--");
      await client.session.abort({ sessionID: session.id, directory: repo.dir });
    }
    if (aborted && e.type === "session.idle") break;
  }
  console.log(`LIVE abort sequence: ${JSON.stringify(seen.filter((t, i) => t !== seen[i - 1] || !t.startsWith("message.part")))}`);
  expect(seen).toContain("session.idle");
}, 120_000);
