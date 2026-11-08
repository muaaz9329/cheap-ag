import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { loadConfig, privateHost } from "../src/config.js";
import { consentGate, routeMoved, writeConsent } from "../src/consent.js";
import { detectProvider } from "../src/credentials.js";
import { ensureOpencode, stopOpencode } from "../src/opencode.js";
import { chain, escalationSkip, fullRoute, modelName, presetOf, routeModels } from "../src/routing.js";
import { runSession } from "../src/worker.js";
import { startFakeLlm } from "./fake-llm.js";
import { callText, hermeticHome, homeEnv, slow, startServer, tempRepo } from "./harness.js";

/** The local provider: any OpenAI-compatible server the user config names (llama.cpp, Strata, Ollama, LM Studio, vLLM, LiteLLM). */

const LOCAL = { base_url: "http://127.0.0.1:8084/v1", model: "qwen3.8-flash-next-gyro-gyro-s" };

/** A hermetic home whose user config holds `config`, with this process's XDG paths pointed at it. */
function home(config: object, logins: Record<string, string> = {}) {
  const h = hermeticHome(logins);
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  for (const [key, value] of Object.entries(homeEnv(h.home))) if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  return { ...h, file };
}

/** The OpenCode server a test booted in this process, if any. */
let booted: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  stopOpencode(true);
  // OpenCode tries port 4096 before a free one, so the next boot reuses this origin: wait until the port refuses, by
  // when fetch has also dropped its kept-alive sockets to the dead server (reusing one fails the next health check)
  const refused = (url: string) => fetch(url).then(() => false, (e) => e.cause?.code === "ECONNREFUSED");
  while (booted && !(await refused(booted))) await new Promise((r) => setTimeout(r, 100));
  booted = undefined;
});

test("the configured model implements and researches; no fallbacks, and no escalation unless models names one", () => {
  home({ local: LOCAL });
  const route = fullRoute("local");
  expect(modelName(route.implement)).toBe("local/qwen3.8-flash-next-gyro-gyro-s");
  expect(modelName(route.research!)).toBe("local/qwen3.8-flash-next-gyro-gyro-s");
  expect(route.escalation).toBeUndefined();
  expect(route.fallbacks).toEqual([]);
  expect(presetOf("local")).toBe("custom");

  // models still overrides per role; names for other providers (a preset left from a hosted login) are ignored
  const tuned = fullRoute("local", { implement: "openrouter/deepseek/deepseek-v4.1-flash", hard: "local/qwen3.6-35b-a3b", escalation: "local/mimo-v2.6-pro" });
  expect(modelName(tuned.implement)).toBe("local/qwen3.8-flash-next-gyro-gyro-s");
  expect(modelName(tuned.hard!)).toBe("local/qwen3.6-35b-a3b");
  expect(modelName(tuned.escalation!)).toBe("local/mimo-v2.6-pro");
});

test("a configured local server wins over a saved hosted login; without one, the login is used", () => {
  home({ local: LOCAL }, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "local", via: "config" });
  home({}, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });
});

test("local is user config only: a repo's cheapag.json cannot point the worker at another server; bad entries are named", () => {
  const { file } = home({ local: LOCAL });
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  expect(loadConfig(repo.dir).models).toEqual({});
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ local: { ...LOCAL, base_url: "https://elsewhere.example/v1" } }));
  expect(() => loadConfig(repo.dir)).toThrow(/local can only be set in .*config\.json, never in a repo/);

  writeFileSync(file, JSON.stringify({ local: { model: "m" } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/local\.base_url must be an http\(s\) URL/);
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, api_key_file: "key.txt" } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/local\.api_key_file must be an absolute path/);
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, context: "128k" } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/local\.context must be a positive whole number/);
  // a damaged entry is not a usable provider
  expect(detectProvider()).toBeUndefined();
});

test("custom endpoint checks: plain http only to a private host; the key from a file or an env var, not both; prices are two numbers", () => {
  for (const url of ["http://127.0.0.1:8080/v1", "http://localhost:1234/v1", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://192.168.1.9/v1", "http://box.local/v1", "http://[::1]:8080/v1", "http://100.101.102.103/v1", "http://gpu-box:8080/v1", "http://desktop.lan/v1", "http://nas.home.arpa/v1"]) expect(privateHost(url), url).toBe(true);
  for (const url of ["http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://100.128.0.1/v1", "http://gateway.example.com/v1", "http://fcbarcelona.com/v1"]) expect(privateHost(url), url).toBe(false);

  const { file } = home({ local: { ...LOCAL, base_url: "https://gateway.example.com/v1", api_key_env: "GATEWAY_KEY", price: { input: 0.27, output: 1.1 } } });
  expect(() => loadConfig(tempRepo().dir)).not.toThrow();
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, base_url: "http://gateway.example.com/v1" } }));
  expect(() => loadConfig(tempRepo().dir)).not.toThrow();
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, api_key_env: "GATEWAY_KEY", api_key_file: "/k" } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/api_key_file or api_key_env, not both/);
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, api_key_env: "not a name" } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/api_key_env must be an environment variable name/);
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, price: { input: 1 } } }));
  expect(() => loadConfig(tempRepo().dir)).toThrow(/local\.price must be/);
});

test("consent names the server, and asks again when the same model id moves to another URL", () => {
  const { file } = home({ local: LOCAL });
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const gate = consentGate(repo.dir, "local");
  expect("block" in gate && gate.block).toContain("custom endpoint at http://127.0.0.1:8084/v1: qwen3.8-flash-next-gyro-gyro-s");
  writeConsent(repo.dir, { mode: "all", provider: "local", approvedAt: new Date().toISOString() });
  const consent = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "consent.json"), "utf8"));
  expect(routeMoved(repo.dir, consent)).toBe(false);
  expect("route" in consentGate(repo.dir, "local")).toBe(true);

  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, base_url: "http://192.168.1.9:8084/v1" } }));
  expect(routeMoved(repo.dir, consent)).toBe(true);
  expect("block" in consentGate(repo.dir, "local")).toBe(true);
});

test("ping reports the local provider, and the generated OpenCode config declares it at the user's URL with its limits and key file", async () => {
  const health = createServer((_, res) => res.end(JSON.stringify({ healthy: true, version: "0.0.0" })));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
  onTestFinished(() => void health.close());
  const { home: dir, file } = home({});
  const local = { ...LOCAL, api_key_file: join(dir, "llama.key"), context: 131072 };
  writeFileSync(file, JSON.stringify({ local }));
  const server = await startServer({ env: { ...homeEnv(dir), CHEAPAG_OPENCODE_URL: `http://127.0.0.1:${(health.address() as { port: number }).port}` } });
  onTestFinished(server.close);
  // the version check fails against the stand-in, after the config is written
  expect(await callText(server.client, "ping")).toMatch(/^FAIL reason: opencode version 0\.0\.0/);
  const config = JSON.parse(readFileSync(join(server.home, ".cheapag", "opencode", "opencode.json"), "utf8"));
  expect(config).toEqual({
    $schema: "https://opencode.ai/config.json",
    small_model: "local/qwen3.8-flash-next-gyro-gyro-s",
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom endpoint",
        // OpenCode resolves {file:} itself: the key never enters the config
        options: { baseURL: "http://127.0.0.1:8084/v1", apiKey: `{file:${local.api_key_file}}` },
        models: { "qwen3.8-flash-next-gyro-gyro-s": { name: "qwen3.8-flash-next-gyro-gyro-s", limit: { context: 131072, output: 32768 } } },
      },
    },
  });
});

test("a gateway's key from an env var and its prices reach the generated OpenCode config as references and costs", async () => {
  const health = createServer((_, res) => res.end(JSON.stringify({ healthy: true, version: "0.0.0" })));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
  onTestFinished(() => void health.close());
  const { home: dir, file } = home({});
  writeFileSync(file, JSON.stringify({ local: { ...LOCAL, base_url: "https://gateway.example.com/v1", api_key_env: "GATEWAY_KEY", price: { input: 0.27, output: 1.1 } } }));
  const server = await startServer({ env: { ...homeEnv(dir), CHEAPAG_OPENCODE_URL: `http://127.0.0.1:${(health.address() as { port: number }).port}` } });
  onTestFinished(server.close);
  await callText(server.client, "ping");
  const config = JSON.parse(readFileSync(join(server.home, ".cheapag", "opencode", "opencode.json"), "utf8"));
  expect(config.provider.local.options).toEqual({ baseURL: "https://gateway.example.com/v1", apiKey: "{env:GATEWAY_KEY}" });
  expect(config.provider.local.models[LOCAL.model]).toEqual({ name: LOCAL.model, cost: { input: 0.27, output: 1.1 } });
});

test.each([
  ["without a key", { kind: "none" }],
  ["with a key file", { kind: "file", key: "local-key-0123456789" }],
  ["with a key from an environment variable and prices", { kind: "env", key: "env-key-0123456789" }],
] as const)("the real bundled OpenCode runs the worker on a local server %s", async (_, source) => {
  const llm = await startFakeLlm();
  onTestFinished(llm.close);
  const { home: dir } = home({});
  const keyFile = join(dir, "server.key");
  if (source.kind === "file") writeFileSync(keyFile, `${source.key}\n`); // as `echo key > file` writes it
  if (source.kind === "env") vi.stubEnv("CHEAPAG_TEST_LOCAL_KEY", source.key);
  home({
    local: {
      base_url: llm.url, model: "bonsai-9b-mtp", context: 65536,
      ...(source.kind === "file" && { api_key_file: keyFile }),
      ...(source.kind === "env" && { api_key_env: "CHEAPAG_TEST_LOCAL_KEY", price: { input: 1, output: 2 } }),
    },
  });
  vi.stubEnv("CHEAPAG_OPENCODE_URL", "");
  const repo = tempRepo();
  onTestFinished(repo.cleanup);

  const route = fullRoute("local");
  expect(routeModels(route).map(modelName)).toEqual(["local/bonsai-9b-mtp"]);
  const opencode = await ensureOpencode({ provider: "local", via: "config" }, repo.dir, route);
  booted = opencode.url;
  const result = await runSession({ opencode, directory: repo.dir, model: route.implement, prompt: "reply OK", onEvent: () => {} });
  expect(result.error).toBeUndefined();
  expect(llm.requests.length).toBeGreaterThan(0);
  const key = source.kind === "none" ? undefined : source.key;
  for (const [i, body] of llm.requests.entries()) {
    expect(body.model).toBe("bonsai-9b-mtp");
    expect(llm.headers[i].authorization).toBe(key ? `Bearer ${key}` : undefined);
  }
  const config = readFileSync(join(repo.dir, ".cheapag", "opencode", "opencode.json"), "utf8");
  expect(config).not.toContain(key ?? "local-key");
  if (source.kind === "env") {
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(config).toContain("{env:CHEAPAG_TEST_LOCAL_KEY}");
  } else {
    expect(result.usage.costUsd).toBe(0);
  }
}, slow(60_000));

test("with no escalation model on the local server, the skip says how to add one", () => {
  home({ local: LOCAL });
  const route = fullRoute("local");
  expect(escalationSkip(route.escalation, chain(route.implement, []), 0.8, {})).toBe(
    "esc: skipped, no escalation model for the local server (set models.escalation, or allow it with /cheapag:allow)",
  );
});
