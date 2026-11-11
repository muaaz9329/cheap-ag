import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { catalog } from "../src/catalog.js";
import { loadConfig, ollamaEndpoint, OLLAMA_CLOUD_URL, OLLAMA_KEY_ENV, OLLAMA_LOCAL_URL } from "../src/config.js";
import { consentGate, modelWarnings, routeMoved, writeConsent } from "../src/consent.js";
import { detectProvider, usableProviders } from "../src/credentials.js";
import { ensureOpencode, stopOpencode } from "../src/opencode.js";
import { effectiveModels, fullRoute, modelName, presetOf, PRESETS } from "../src/routing.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { callText, hermeticHome, homeEnv, startServer, tempRepo } from "./harness.js";

/**
 * The Ollama provider (issue #27): one provider id, two endpoints. `local` is this machine's daemon (no key, the models
 * already pulled); `cloud` is ollama.com, with the key read from OLLAMA_API_KEY by OpenCode, never by Cheap Agent.
 */

const LOCAL = { endpoint: "local", model: "llama3.2" };
const CLOUD = { endpoint: "cloud" };
const AT = "2026-11-11T00:00:00Z";

/** A hermetic home whose user config holds `config`, with this process's XDG paths pointed at it and no Ollama key. */
function home(config: object, logins: Record<string, string> = {}) {
  const h = hermeticHome(logins);
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  for (const [key, value] of Object.entries(homeEnv(h.home))) if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  // a developer's own OLLAMA_API_KEY must not make every detection test see Ollama Cloud
  vi.stubEnv(OLLAMA_KEY_ENV, "");
  return { ...h, file };
}

/** A stand-in Ollama HTTP API on a free loopback port; returns its origin. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  onTestFinished(() => void http.close());
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
};

afterEach(() => {
  vi.unstubAllEnvs();
  stopOpencode(true);
});

test("ollama is user config only, and a local endpoint needs the model it runs", () => {
  const { file } = home({ ollama: LOCAL });
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  expect(ollamaEndpoint()).toEqual({ endpoint: "local", base_url: OLLAMA_LOCAL_URL, model: "llama3.2" });
  expect(loadConfig(repo.dir).models).toEqual({});

  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ ollama: CLOUD }));
  expect(() => loadConfig(repo.dir)).toThrow(/ollama can only be set in .*config\.json, never in a repo/);

  writeFileSync(file, JSON.stringify({ ollama: { endpoint: "local" } }));
  expect(() => loadConfig(repo.dir)).toThrow(/ollama\.model must be the local server's model id/);
  writeFileSync(file, JSON.stringify({ ollama: { endpoint: "cloud", base_url: "http://gateway.example.com/v1" } }));
  expect(() => loadConfig(repo.dir)).toThrow(/ollama\.base_url with plain http must be this machine or a private network/);
  writeFileSync(file, JSON.stringify({ ollama: { endpoint: "cloud", price: { input: 1 } } }));
  expect(() => loadConfig(repo.dir)).toThrow(/ollama\.price must be/);

  // the defaults are this machine's daemon and ollama.com; the cloud key variable is implicit
  writeFileSync(file, JSON.stringify({ ollama: CLOUD }));
  expect(ollamaEndpoint()).toEqual({ endpoint: "cloud", base_url: OLLAMA_CLOUD_URL, api_key_env: OLLAMA_KEY_ENV });
});

test("a set-up Ollama wins over a saved login, an explicit provider wins over both, and the key alone is a cloud opt-in", () => {
  home({ ollama: LOCAL }, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "ollama", via: "config" });
  expect(usableProviders()[0]).toBe("ollama");

  home({ ollama: LOCAL, provider: "openrouter" }, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });

  home({}, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" }); // no key, no block

  vi.stubEnv(OLLAMA_KEY_ENV, "cloud-key-0123456789");
  expect(detectProvider()).toEqual({ provider: "ollama", via: "config" });
  expect(ollamaEndpoint()).toEqual({ endpoint: "cloud", base_url: OLLAMA_CLOUD_URL, api_key_env: OLLAMA_KEY_ENV });

  // a damaged entry is not a usable provider: the saved login is used again
  home({ ollama: { endpoint: "cloud", base_url: "ftp://x" } }, { openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });
});

test("Ollama Cloud routes the issue's roles and presets; on this machine the pulled model implements and researches", () => {
  home({ ollama: CLOUD });
  const route = fullRoute("ollama");
  expect(modelName(route.implement)).toBe("ollama/deepseek-v4.1-flash:cloud");
  expect(route.fallbacks.map(modelName)).toEqual(["ollama/glm-5.3-flash:cloud", "ollama/qwen3.7-plus:cloud"]);
  expect(modelName(route.research!)).toBe("ollama/qwen3.8-flash:cloud");
  expect(modelName(route.escalation!)).toBe("ollama/glm-5.3:cloud");
  expect(presetOf("ollama", PRESETS.ollama.balanced)).toBe("balanced");
  expect(presetOf("ollama", PRESETS.ollama.strongest)).toBe("strongest");
  expect(presetOf("ollama", { implement: "ollama/qwen3.5:8b" })).toBe("custom");

  home({ ollama: { ...LOCAL, context: 131072 } });
  const local = fullRoute("ollama");
  expect(modelName(local.implement)).toBe("ollama/llama3.2");
  expect(modelName(local.research!)).toBe("ollama/llama3.2");
  expect(local.fallbacks).toEqual([]);
  expect(local.escalation).toBeUndefined();
  expect(presetOf("ollama", {})).toBe("custom");
  // a cloud preset left in the user config is not applied to this machine's endpoint
  expect(effectiveModels("ollama", { preset: "strongest", models: {} })).toEqual({});
  // models still overrides a role, and a fallback can be named there
  const tuned = fullRoute("ollama", { implement: "ollama/qwen3.6:latest", fallback: ["ollama/llama3.2"] });
  expect(modelName(tuned.implement)).toBe("ollama/qwen3.6:latest");
  expect(tuned.fallbacks.map(modelName)).toEqual(["ollama/llama3.2"]);
});

test("consent says where the code goes: this machine sends nothing, Ollama Cloud is ollama.com with terms not stated here", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  home({ ollama: LOCAL });

  const local = consentGate(repo.dir, "ollama");
  expect("block" in local && local.block).toContain(`code from this repo → your local Ollama at ${OLLAMA_LOCAL_URL}: llama3.2`);
  expect("block" in local && local.block).toContain("retention: nothing leaves this machine");

  // zero-retention-only admits it: nothing leaves the machine
  writeConsent(repo.dir, { mode: "zdr-only", provider: "ollama", approvedAt: AT });
  expect("route" in consentGate(repo.dir, "ollama")).toBe(true);

  // the URL is a recipient: the same model at another URL asks again
  const consent = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "consent.json"), "utf8"));
  expect(routeMoved(repo.dir, consent)).toBe(false);
  home({ ollama: { ...LOCAL, base_url: "http://192.168.1.9:11434/v1" } });
  expect(routeMoved(repo.dir, consent)).toBe(true);

  // the cloud endpoint is one company: a model change does not ask again, but zdr-only cannot cover it
  const cloudRepo = tempRepo();
  onTestFinished(cloudRepo.cleanup);
  home({ ollama: CLOUD });
  const cloud = consentGate(cloudRepo.dir, "ollama");
  expect("block" in cloud && cloud.block).toContain("code from this repo → Ollama Cloud (ollama.com): deepseek-v4.1-flash:cloud");
  expect("block" in cloud && cloud.block).toContain("retention: Ollama Cloud's terms (ollama.com); retention is not stated here");
  writeConsent(cloudRepo.dir, { mode: "all", provider: "ollama", approvedAt: AT });
  const cloudConsent = JSON.parse(readFileSync(join(cloudRepo.dir, ".cheapag", "consent.json"), "utf8"));
  expect(routeMoved(cloudRepo.dir, cloudConsent)).toBe(false);
  writeConsent(cloudRepo.dir, { mode: "zdr-only", provider: "ollama", approvedAt: AT });
  expect("block" in consentGate(cloudRepo.dir, "ollama")).toBe(true); // no zero-retention statement to rely on
});

test("the generated OpenCode config declares Ollama: the cloud key as an {env:} reference, this machine's endpoint without one", async () => {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  vi.stubEnv("CHEAPAG_OPENCODE_URL", fake.url);
  const repo = tempRepo();
  onTestFinished(repo.cleanup);

  home({ ollama: CLOUD });
  await ensureOpencode({ provider: "ollama", via: "config" }, repo.dir, fullRoute("ollama"));
  const cloud = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "opencode", "opencode.json"), "utf8"));
  expect(cloud).toEqual({
    $schema: "https://opencode.ai/config.json",
    small_model: "ollama/deepseek-v4.1-flash:cloud",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        // OpenCode resolves the reference itself: the key never enters this config
        options: { baseURL: OLLAMA_CLOUD_URL, apiKey: `{env:${OLLAMA_KEY_ENV}}` },
        models: {
          "deepseek-v4.1-flash:cloud": { name: "deepseek-v4.1-flash:cloud" },
          "qwen3.8-flash:cloud": { name: "qwen3.8-flash:cloud" },
          "glm-5.3:cloud": { name: "glm-5.3:cloud" },
          "glm-5.3-flash:cloud": { name: "glm-5.3-flash:cloud" },
          "qwen3.7-plus:cloud": { name: "qwen3.7-plus:cloud" },
        },
      },
    },
  });

  stopOpencode(true);
  home({ ollama: { ...LOCAL, context: 131072 } });
  await ensureOpencode({ provider: "ollama", via: "config" }, repo.dir, fullRoute("ollama"));
  const local = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "opencode", "opencode.json"), "utf8"));
  expect(local.small_model).toBe("ollama/llama3.2");
  expect(local.provider.ollama).toEqual({
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama",
    options: { baseURL: OLLAMA_LOCAL_URL },
    models: { "llama3.2": { name: "llama3.2", limit: { context: 131072, output: 32768 } } },
  });
});

test("the catalog comes from Ollama itself: /api/tags and /api/show on this machine, /v1/models on the cloud", async () => {
  const tags = await serve(async (req, res) => {
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }, { model: "llama3.2:latest" }] }));
    if (req.url === "/api/show") {
      const { model } = await body(req);
      return res.end(JSON.stringify({ model_info: model === "qwen3:8b" ? { "qwen3.context_length": 32768 } : {} }));
    }
    res.writeHead(404).end();
  });
  home({ ollama: { ...LOCAL, base_url: `${tags}/v1` } });
  // sorted by id; a model whose /api/show reports no window reads 0, not a guess
  expect(await catalog({ provider: "ollama", via: "config" }, process.cwd())).toEqual([
    { id: "llama3.2:latest", name: "llama3.2:latest", input: 0, output: 0, context: 0, efforts: [] },
    { id: "qwen3:8b", name: "qwen3:8b", input: 0, output: 0, context: 32768, efforts: [] },
  ]);

  const seen: (string | undefined)[] = [];
  const cloud = await serve((req, res) => {
    seen.push(req.headers.authorization);
    res.end(JSON.stringify({ data: [{ id: "glm-5.3:cloud" }, { id: "deepseek-v4.1-flash:cloud" }] }));
  });
  home({ ollama: { endpoint: "cloud", base_url: `${cloud}/v1` } });
  vi.stubEnv(OLLAMA_KEY_ENV, "cloud-key-0123456789"); // after home(), which clears a developer's key
  expect((await catalog({ provider: "ollama", via: "config" }, process.cwd())).map((m) => m.id)).toEqual(["glm-5.3:cloud", "deepseek-v4.1-flash:cloud"]);
  expect(seen).toEqual([`Bearer cloud-key-0123456789`]);
});

test("catalog failures say what to do: pull a model, start the daemon, or check the key", async () => {
  const empty = await serve((_, res) => res.end(JSON.stringify({ models: [] })));
  home({ ollama: { ...LOCAL, base_url: `${empty}/v1` } });
  await expect(catalog({ provider: "ollama", via: "config" }, process.cwd())).rejects.toThrow(/has no models pulled; run ollama pull <model>/);

  home({ ollama: { ...LOCAL, base_url: "http://127.0.0.1:1/v1" } });
  await expect(catalog({ provider: "ollama", via: "config" }, process.cwd())).rejects.toThrow(/could not reach Ollama at http:\/\/127\.0\.0\.1:1 \(/);

  const rejected = await serve((_, res) => {
    res.writeHead(401).end();
  });
  home({ ollama: { endpoint: "cloud", base_url: `${rejected}/v1` } });
  vi.stubEnv(OLLAMA_KEY_ENV, "bad-key");
  await expect(catalog({ provider: "ollama", via: "config" }, process.cwd())).rejects.toThrow(/Ollama Cloud rejected the key \(401\); check OLLAMA_API_KEY/);
});

test("a models entry naming another provider is reported with the model that actually runs", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  home({ ollama: CLOUD });
  expect(modelWarnings("ollama", repo.dir)).toEqual([]);

  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { implement: "openrouter/deepseek/deepseek-v4.1-flash" } }));
  expect(modelWarnings("ollama", repo.dir)).toEqual([
    "models.implement names openrouter/deepseek/deepseek-v4.1-flash, which is not a model on Ollama; it is ignored and the worker runs ollama/deepseek-v4.1-flash:cloud. Fix it in cheapag.json or run npx cheap-agent model",
  ]);

  // ping shows it after its OK line, so the stale model cannot pass unnoticed
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const { home: dir } = home({ ollama: CLOUD });
  const server = await startServer({ cwd: repo.dir, env: { ...homeEnv(dir), CHEAPAG_OPENCODE_URL: fake.url } });
  onTestFinished(server.close);
  const ping = await callText(server.client, "ping", { root: repo.dir });
  expect(ping.split("\n")[0]).toContain("provider=ollama via=config preset=balanced");
  expect(ping).toContain("! models.implement names openrouter/deepseek/deepseek-v4.1-flash");
}, 60_000);
