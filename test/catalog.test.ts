import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { createServer } from "node:http";
import { catalog, ollamaModels, saveModels } from "../src/catalog.js";
import { loadConfig, userConfigFile } from "../src/config.js";
import { stopOpencode } from "../src/opencode.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { hermeticHome } from "./harness.js";

const GO = { provider: "opencode-go", via: "login" } as const;

/** A hermetic home and dir, with OpenCode pointed at the fake. */
async function setup(config?: object) {
  const fake = await startFakeOpencode();
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
  return dir;
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
