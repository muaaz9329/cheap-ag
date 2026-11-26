import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { catalog, ollamaModels, saveModels } from "../src/catalog.js";
import { loadConfig, OLLAMA_KEY_ENV, userConfigFile } from "../src/config.js";
import { OPENCODE_PIN, stopOpencode } from "../src/opencode.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { hermeticHome } from "./harness.js";

const GO = { provider: "opencode-go", via: "login" } as const;

/** A hermetic home and dir, with OpenCode pointed at the fake. */
async function setup(config?: object) {
  return (await setupWithFake(config)).dir;
}

/** setup(), also returning the fake so a test can read the requests it got. */
async function setupWithFake(
  config?: object,
  fakeOptions?: Parameters<typeof startFakeOpencode>[0],
) {
  const fake = await startFakeOpencode(fakeOptions);
  const { home } = hermeticHome();
  const dir = mkdtempSync(join(tmpdir(), "cheapag-catalog-"));
  vi.stubEnv("CHEAPAG_OPENCODE_URL", fake.url);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  if (config) {
    mkdirSync(dirname(userConfigFile()), { recursive: true });
    writeFileSync(userConfigFile(), JSON.stringify(config));
  }
  onTestFinished(async () => {
    stopOpencode();
    vi.unstubAllEnvs();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, fake };
}

type Seen = { method?: string; url?: string; authorization?: string; body: string };

/** A stand-in HTTP server on a free loopback port that records every request; returns its origin. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    handler(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, seen };
}

test("the catalog keeps tool-calling models only, cheapest first, with their efforts", async () => {
  const dir = await setup();
  const models = await catalog(GO, dir);
  expect(models.map((m) => [m.id, m.efforts])).toEqual([
    ["small-flash", []],
    ["big-reasoner", ["high", "max"]],
  ]);
  expect(models[1]).toMatchObject({ input: 0.9, output: 2.7, context: 256_000 });
});

test("saveModels writes models and efforts, keeps other keys, and removes preset", async () => {
  await setup({
    preset: "strongest",
    test_cmd: "npm test",
    models: { research: "opencode-go/x", variants: { "opencode-go/old": "low" } },
  });
  saveModels(GO, { main: "big-reasoner", mainEffort: "high", fallback: "small-flash" });
  const saved = JSON.parse(readFileSync(userConfigFile(), "utf8"));
  expect(saved).toEqual({
    test_cmd: "npm test",
    models: {
      research: "opencode-go/big-reasoner",
      implement: "opencode-go/big-reasoner",
      fallback: ["opencode-go/small-flash"],
      variants: { "opencode-go/big-reasoner": "high" },
    },
  });
  saveModels(GO, { main: "small-flash", fallback: null });
  const again = JSON.parse(readFileSync(userConfigFile(), "utf8"));
  expect(again.models).toEqual({
    research: "opencode-go/small-flash",
    implement: "opencode-go/small-flash",
    fallback: [],
  }); // research follows main; none means no fallback
  expect(loadConfig(tmpdir()).preset).toBeUndefined();
});

test("ollamaModels local: a model whose /api/show fails still lists, with context 0", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/api/tags")
      return void res.end(JSON.stringify({ models: [{ name: "llama3.2" }] }));
    req.socket.destroy(); // /api/show: the connection drops
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  const { port } = server.address() as { port: number };
  expect(await ollamaModels("local", `http://127.0.0.1:${port}/v1/`)).toEqual([
    { id: "llama3.2", name: "llama3.2", input: 0, output: 0, context: 0, efforts: [] },
  ]);
});

test("ollamaModels cloud: an unreachable endpoint says so and asks whether the machine is online", async () => {
  await expect(ollamaModels("cloud", "http://127.0.0.1:1/v1", "key")).rejects.toThrow(
    /^could not reach Ollama Cloud at http:\/\/127\.0\.0\.1:1\/v1 \(.+\); is this machine online\?$/,
  );
});

const FIELDS = ["id", "name", "input", "output", "context", "efforts"];

test("the catalog asks OpenCode for its health, then its providers in this dir, and returns each field in order", async () => {
  const { dir, fake } = await setupWithFake();
  const models = await catalog(GO, dir);
  expect(models).toEqual([
    {
      id: "small-flash",
      name: "Small Flash",
      input: 0.14,
      output: 0.28,
      context: 128_000,
      efforts: [],
    },
    {
      id: "big-reasoner",
      name: "Big Reasoner",
      input: 0.9,
      output: 2.7,
      context: 256_000,
      efforts: ["high", "max"],
    },
  ]);
  expect(models.map((model) => Object.keys(model))).toEqual([FIELDS, FIELDS]);
  const requests = fake.recorded.requests.map((request) => `${request.method} ${request.path}`);
  expect(requests).toEqual(["GET /global/health", "GET /config/providers"]);
  expect(fake.recorded.requests[1]!.directory).toBe(dir);
});

test("catalog models with the same input price keep OpenCode's order", async () => {
  const model = { toolcall: true, output: 1, context: 1000 };
  const providers = [
    {
      id: "opencode-go",
      models: [
        { ...model, id: "tie-first", name: "Tie First", input: 0.5 },
        { ...model, id: "tie-second", name: "Tie Second", input: 0.5 },
        { ...model, id: "cheapest", name: "Cheapest", input: 0.1, variants: [] },
      ],
    },
  ];
  const { dir } = await setupWithFake(undefined, { providers });
  const models = await catalog(GO, dir);
  expect(models.map((listed) => [listed.id, listed.efforts])).toEqual([
    ["cheapest", []],
    ["tie-first", []],
    ["tie-second", []],
  ]);
});

test("a provider OpenCode does not list is an error that names it", async () => {
  const { dir } = await setupWithFake();
  await expect(catalog({ provider: "openrouter", via: "login" }, dir)).rejects.toThrow(
    /^OpenCode lists no models for openrouter$/,
  );
});

test("a catalog OpenCode will not give is an error with what it answered", async () => {
  const { dir } = await setupWithFake();
  const opencode = await serve((req, res) => {
    if (req.url === "/global/health")
      return void res.end(JSON.stringify({ healthy: true, version: OPENCODE_PIN }));
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "UnknownError", data: { message: "boom" } }));
  });
  vi.stubEnv("CHEAPAG_OPENCODE_URL", opencode.origin);
  await expect(catalog(GO, dir)).rejects.toThrow(
    new Error(
      `could not read OpenCode's model catalog: {"name":"UnknownError","data":{"message":"boom"}}`,
    ),
  );
});

test("an Ollama catalog without an endpoint says to log in and asks OpenCode nothing", async () => {
  const { dir, fake } = await setupWithFake();
  vi.stubEnv(OLLAMA_KEY_ENV, "");
  await expect(catalog({ provider: "ollama", via: "config" }, dir)).rejects.toThrow(
    new Error("no Ollama endpoint configured; run npx cheap-agent login"),
  );
  expect(fake.recorded.requests).toEqual([]);
});

test("an Ollama catalog comes from the configured Ollama alone; OpenCode is asked nothing", async () => {
  const ollama = await serve((req, res) => {
    if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "m" }] }));
    res.end("{}");
  });
  const config = { ollama: { endpoint: "local", model: "m", base_url: `${ollama.origin}/v1` } };
  const { dir, fake } = await setupWithFake(config);
  expect(await catalog({ provider: "ollama", via: "config" }, dir)).toEqual([
    { id: "m", name: "m", input: 0, output: 0, context: 0, efforts: [] },
  ]);
  expect(ollama.seen.map((request) => request.url)).toEqual(["/api/tags", "/api/show"]);
  expect(fake.recorded.requests).toEqual([]);
});

test("ollamaModels local: tags first, then every /api/show at once; ids deduped and sorted, name before model", async () => {
  const shows: (() => void)[] = [];
  const contexts: Record<string, object> = {
    "gemma3:4b": {
      model_info: {
        "general.context_length": 0,
        "gemma3.context_length": "8192",
        "gemma3.block_count": 8,
        "first.context_length": 4096,
        "second.context_length": 8192,
      },
    },
    "qwen3:8b": { model_info: { "qwen3.context_length": 32768 } },
  };
  const ollama = await serve((req, res, body) => {
    if (req.url === "/api/tags") {
      const models = [
        { name: "qwen3:8b", model: "ignored:tag" },
        { model: "llama3.2:latest" },
        { name: "qwen3:8b" },
        { name: 7, model: "gemma3:4b" },
        { name: 7 },
        {},
      ];
      return void res.end(JSON.stringify({ models }));
    }
    const { model } = JSON.parse(body) as { model: string };
    // answer only once all three are in, so asking one at a time would time out
    shows.push(() => {
      if (model === "llama3.2:latest") return void res.writeHead(500).end();
      res.end(JSON.stringify(contexts[model]));
    });
    if (shows.length === 3) for (const answer of shows) answer();
  });
  expect(await ollamaModels("local", `${ollama.origin}/v1///`)).toEqual([
    { id: "gemma3:4b", name: "gemma3:4b", input: 0, output: 0, context: 4096, efforts: [] },
    {
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      input: 0,
      output: 0,
      context: 0,
      efforts: [],
    },
    { id: "qwen3:8b", name: "qwen3:8b", input: 0, output: 0, context: 32768, efforts: [] },
  ]);
  expect(ollama.seen[0]).toEqual({ method: "GET", url: "/api/tags", body: "" });
  const showRequests = ollama.seen.slice(1).map((request) => [request.method, request.url]);
  expect(showRequests).toEqual([
    ["POST", "/api/show"],
    ["POST", "/api/show"],
    ["POST", "/api/show"],
  ]);
  const shown = ollama.seen.slice(1).map((request) => request.body);
  expect(shown.sort()).toEqual([
    `{"model":"gemma3:4b"}`,
    `{"model":"llama3.2:latest"}`,
    `{"model":"qwen3:8b"}`,
  ]);
});

test("ollamaModels local: each failure has its own message", async () => {
  await expect(ollamaModels("local", "http://127.0.0.1:1/v1")).rejects.toThrow(
    /^could not reach Ollama at http:\/\/127\.0\.0\.1:1 \(.+\); is it running\?$/,
  );
  const broken = await serve((_, res) => void res.writeHead(500).end());
  await expect(ollamaModels("local", `${broken.origin}/v1`)).rejects.toThrow(
    new Error(`Ollama at ${broken.origin} answered 500; is it running?`),
  );
  const empty = await serve((_, res) => void res.end("{}"));
  await expect(ollamaModels("local", `${empty.origin}/v1`)).rejects.toThrow(
    new Error(
      `Ollama at ${empty.origin} has no models pulled; run ollama pull <model>, then try again`,
    ),
  );
});

test("ollamaModels cloud: one GET /models, a bearer key only when there is one, ids in the listed order", async () => {
  const data = [{ id: "glm-5.3:cloud" }, { id: "a:cloud" }, { id: "glm-5.3:cloud" }, { id: 3 }, {}];
  const cloud = await serve((_, res) => void res.end(JSON.stringify({ data })));
  const zero = { input: 0, output: 0, context: 0, efforts: [] };
  const expected = [
    { id: "glm-5.3:cloud", name: "glm-5.3:cloud", ...zero },
    { id: "a:cloud", name: "a:cloud", ...zero },
    { id: "glm-5.3:cloud", name: "glm-5.3:cloud", ...zero },
  ];
  const listed = await ollamaModels("cloud", `${cloud.origin}/v1//`);
  expect(listed).toEqual(expected);
  expect(listed.map((model) => Object.keys(model))).toEqual([FIELDS, FIELDS, FIELDS]);
  expect(await ollamaModels("cloud", `${cloud.origin}/v1`, "")).toEqual(expected);
  expect(await ollamaModels("cloud", `${cloud.origin}/v1`, "cloud-key")).toEqual(expected);
  expect(cloud.seen).toEqual([
    { method: "GET", url: "/v1/models", body: "" },
    { method: "GET", url: "/v1/models", body: "" },
    { method: "GET", url: "/v1/models", authorization: "Bearer cloud-key", body: "" },
  ]);
});

test.each([
  [401, "Ollama Cloud rejected the key (401); check OLLAMA_API_KEY"],
  [403, "Ollama Cloud rejected the key (403); check OLLAMA_API_KEY"],
  [500, "Ollama Cloud answered 500"],
])("ollamaModels cloud: status %i says %s", async (status, message) => {
  const cloud = await serve((_, res) => void res.writeHead(status).end());
  await expect(ollamaModels("cloud", `${cloud.origin}/v1`, "key")).rejects.toThrow(
    new Error(message),
  );
});

test("ollamaModels cloud: an empty list is an error", async () => {
  const cloud = await serve((_, res) => void res.end(JSON.stringify({ data: [{ id: 1 }] })));
  await expect(ollamaModels("cloud", `${cloud.origin}/v1`)).rejects.toThrow(
    new Error("Ollama Cloud listed no models"),
  );
  const missing = await serve((_, res) => void res.end("{}"));
  await expect(ollamaModels("cloud", `${missing.origin}/v1`)).rejects.toThrow(
    new Error("Ollama Cloud listed no models"),
  );
});

test("saveModels writes the file byte for byte: key order kept, two-space indent, a final newline", async () => {
  await setup({
    test_cmd: "npm test",
    models: {
      research: "opencode-go/x",
      fallback: ["opencode-go/old"],
      implement: "opencode-go/y",
      variants: { "opencode-go/old": "low" },
      escalation: "opencode-go/z",
    },
    preset: "balanced",
    limits: { max_turns: 5 },
  });
  saveModels(GO, {
    main: "big-reasoner",
    mainEffort: "high",
    fallback: "small-flash",
    fallbackEffort: "low",
  });
  const expected = {
    test_cmd: "npm test",
    models: {
      research: "opencode-go/big-reasoner",
      implement: "opencode-go/big-reasoner",
      escalation: "opencode-go/z",
      fallback: ["opencode-go/small-flash"],
      variants: { "opencode-go/big-reasoner": "high", "opencode-go/small-flash": "low" },
    },
    limits: { max_turns: 5 },
  };
  expect(readFileSync(userConfigFile(), "utf8")).toBe(JSON.stringify(expected, null, 2) + "\n");
});

test("saveModels creates a missing config, and keeps an effort only for a model that is set", async () => {
  await setup();
  saveModels(GO, { main: "small-flash", fallbackEffort: "low" });
  const created = {
    models: {
      implement: "opencode-go/small-flash",
      research: "opencode-go/small-flash",
      fallback: [],
    },
  };
  expect(readFileSync(userConfigFile(), "utf8")).toBe(JSON.stringify(created, null, 2) + "\n");

  saveModels(GO, { main: "small-flash", fallback: "big-reasoner", fallbackEffort: "max" });
  const saved = JSON.parse(readFileSync(userConfigFile(), "utf8"));
  expect(saved.models.variants).toEqual({ "opencode-go/big-reasoner": "max" });

  // the same model as main and fallback: the fallback's effort is the one kept
  saveModels(GO, { main: "m", mainEffort: "high", fallback: "m", fallbackEffort: "low" });
  const same = JSON.parse(readFileSync(userConfigFile(), "utf8"));
  expect(same.models.variants).toEqual({ "opencode-go/m": "low" });
});
