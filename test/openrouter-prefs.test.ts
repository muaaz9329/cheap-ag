import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { expect, onTestFinished, test } from "vitest";
import { consentGate, writeConsent } from "../src/consent.js";
import { opencodeBinary } from "../src/opencode.js";
import { startFakeLlm } from "./fake-llm.js";
import { hermeticHome, tempRepo } from "./harness.js";

/**
 * OpenRouter routing preferences, as the real bundled OpenCode actually sends them. The model options come from
 * Cheap Agent's own consent code; the fake model stands in for OpenRouter's API so the request body can be read.
 */
test.each([
  ["all", { data_collection: "deny" }],
  ["zdr-only", { data_collection: "deny", zdr: true }],
] as const)("consent %s → OpenRouter request body carries provider %j", async (mode, expected) => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeConsent(repo.dir, { mode, provider: "openrouter", approvedAt: new Date().toISOString() } as Parameters<typeof writeConsent>[1]);
  const gate = consentGate(repo.dir, "openrouter");
  if (!("route" in gate)) throw new Error(gate.block);
  const model = gate.route.implement;

  const llm = await startFakeLlm();
  onTestFinished(llm.close);
  const { home, env } = hermeticHome({ openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  const config = join(home, "oc");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    small_model: `openrouter/${model.id}`,
    provider: { openrouter: { options: { baseURL: llm.url }, models: { [model.id]: { options: model.options } } } },
  }));
  const oc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "t", OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  });
  oc.stderr.resume();
  const kill = () => {
    try {
        process.kill(-oc.pid!, "SIGKILL");
      } catch {
        // gone
      }
    };
    process.once("exit", kill);
    try {
    const url = await new Promise<string>((resolve, reject) => {
      oc.stdout.on("data", (d) => String(d).match(/(http:\/\/\S+)/) && resolve(String(d).match(/(http:\/\/\S+)/)![1]));
      oc.on("exit", (code) => reject(new Error(`opencode exited ${code}`)));
    });
    const client = createOpencodeClient({ baseUrl: url, directory: repo.dir, headers: { authorization: `Basic ${Buffer.from("opencode:t").toString("base64")}` } });
    const { stream } = await client.event.subscribe({ directory: repo.dir });
    await stream.next();
    const session = (await client.session.create({ directory: repo.dir, model: { providerID: "openrouter", id: model.id } })).data!;
    await client.session.promptAsync({ sessionID: session.id, directory: repo.dir, parts: [{ type: "text", text: "hi" }] });
    for await (const raw of stream) {
      const e = raw as Event;
      if (e.type === "session.idle" && e.properties.sessionID === session.id) break;
    }
    // every request (the title one included) carries the preference, exactly
    expect(llm.requests.length).toBeGreaterThan(0);
    for (const body of llm.requests) expect(body.provider).toEqual(expected);
  } finally {
    kill(); // in the body, not a hook: this server must never outlive the test
  }
}, 60_000);
