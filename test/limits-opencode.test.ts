import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";
import { opencodeBinary } from "../src/opencode.js";
import { killProcessGroup } from "../src/platform.js";
import { openSession } from "../src/worker.js";
import { startFakeLlm } from "./fake-llm.js";
import { hermeticHome, slow, tempRepo } from "./harness.js";

/**
 * Provider limits as the real bundled OpenCode reports them, read by Cheap Agent's own worker. The fake model stands in
 * for OpenRouter's API and answers with Go-limit, 429 and 402 responses; OpenCode turns them into retry statuses or errors.
 * Also checks that a prompt's model override switches the model mid-session, which fallback relies on.
 */

const FLASH = "deepseek/deepseek-v4.1-flash";
const QWEN = "qwen/qwen3.7-plus";
let llm: Awaited<ReturnType<typeof startFakeLlm>>;
let opencode: { url: string; password: string; version: string };
let client: ReturnType<typeof createOpencodeClient>;
let kill = () => {};

beforeAll(async () => {
  llm = await startFakeLlm();
  const { home, env } = hermeticHome({ openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  const config = join(home, "oc");
  mkdirSync(join(config, "agents"), { recursive: true });
  writeFileSync(join(config, "agents", "cheapag-worker.md"), "---\ndescription: worker\nmode: primary\n---\nYou implement plan steps.\n");
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    small_model: `openrouter/${FLASH}`,
    provider: { openrouter: { options: { baseURL: llm.url }, models: { [FLASH]: {}, [QWEN]: {} } } },
  }));
  const oc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "t", OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  });
  oc.stderr.resume();
  kill = () => killProcessGroup(oc.pid, "SIGKILL");
  process.once("exit", kill);
  const url = await new Promise<string>((resolve, reject) => {
    oc.stdout.on("data", (d) => String(d).match(/(http:\/\/\S+)/) && resolve(String(d).match(/(http:\/\/\S+)/)![1]));
    oc.on("exit", (code) => reject(new Error(`opencode exited ${code}`)));
  });
  opencode = { url, password: "t", version: "" };
  client = createOpencodeClient({ baseUrl: url, directory: process.cwd(), headers: { authorization: `Basic ${Buffer.from("opencode:t").toString("base64")}` } });
}, slow(60_000));

afterAll(async () => {
  kill(); // SIGKILL: this server must never outlive the suite
  await llm?.close();
});

async function session() {
  const repo = tempRepo();
  // dispose the repo's instance before the repo is removed: the running OpenCode holds its directory open (Windows cannot delete one)
  onTestFinished(async () => {
    await client.instance.dispose({ directory: repo.dir }).catch(() => {});
    repo.cleanup();
  });
  return openSession({ opencode, directory: repo.dir, model: { providerID: "openrouter", id: FLASH }, onEvent: () => {} });
}

const tools = () => llm.requests.filter((r) => r.tools?.length); // title generation sends none

test("a Go limit: the retry status is read at once, the session aborted, and a model override continues it on the fallback", async () => {
  const before = tools().length;
  const body = { type: "error", error: { type: "GoUsageLimitError", message: "limit" }, metadata: { workspace: "wrk_test", limitName: "5h" } };
  llm.script({ status: 429, body, headers: { "retry-after": "8040" } }); // 2 h 14 min
  const s = await session();
  const started = Date.now();
  const limited = await s.run("do step 1");
  expect(Date.now() - started).toBeLessThan(15_000); // never waits out the retry-after
  expect(limited.limit).toMatchObject({
    model: `openrouter/${FLASH}`, reason: "account_rate_limit",
    message: "5h usage limit reached. It will reset in 2 hours 14 minutes. To continue using this model now, enable usage from your available balance",
  });
  // OpenCode's next retry is the provider's retry-after: the reset time
  expect(Math.abs(limited.limit!.next - (started + 8_040_000))).toBeLessThan(15_000);

  const resumed = await s.run("continue", { providerID: "openrouter", id: QWEN });
  expect(resumed.error).toBeUndefined();
  expect(resumed.limit).toBeUndefined();
  expect(tools().slice(before).map((r) => r.model)).toEqual([FLASH, QWEN]);
  // same session: the continued request carries the earlier prompt
  expect(JSON.stringify(tools().at(-1).messages)).toContain("do step 1");
  expect(s.totals().spend).toHaveProperty(`openrouter/${QWEN}`);
}, slow(30_000));

test("a plain 429 (OpenRouter rate limit) is a retry status without a Go reason, and is stopped the same way", async () => {
  llm.script({ status: 429, body: { error: { message: "Rate limit exceeded: free-models-per-min", code: 429 } }, headers: { "retry-after": "600" } });
  const s = await session();
  const limited = await s.run("do step 1");
  expect(limited.limit).toMatchObject({ model: `openrouter/${FLASH}`, reason: undefined });
  expect(limited.limit!.message).toMatch(/rate limit/i);
}, slow(30_000));

test("a 402 (OpenRouter out of credits) is not retried: the run ends with the error and its HTTP status", async () => {
  llm.script({ status: 402, body: { error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } } });
  const s = await session();
  const failed = await s.run("do step 1");
  expect(failed.limit).toBeUndefined();
  expect(failed.httpStatus).toBe(402);
  expect(failed.error).toMatch(/Insufficient credits/);
}, slow(30_000));
