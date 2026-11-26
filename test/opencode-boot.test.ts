import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Provider } from "../src/credentials.js";
import {
  ensureOpencode,
  holdOpencode,
  opencodeBinary,
  OPENCODE_PIN,
  runningOpencode,
  stopOpencode,
} from "../src/opencode.js";
import { baselinePermission } from "../src/permissions.js";
import { isAlive } from "../src/platform.js";
import { fullRoute, PRESETS } from "../src/routing.js";
import { slow } from "./harness.js";

/** What stands in for `opencode serve`: a Node script run in its place, and the CPU architecture reported. */
const stand = vi.hoisted(() => ({
  script: "",
  arch: undefined as string | undefined,
  pids: [] as number[],
  children: [] as ChildProcess[],
  spawns: [] as { command: string; args: string[]; options: SpawnOptions }[],
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: string[], options: SpawnOptions) => {
      if (args?.[0] !== "serve") return actual.spawn(command, args, options);
      stand.spawns.push({ command, args, options });
      const child = actual.spawn(process.execPath, ["-e", stand.script], options);
      stand.pids.push(child.pid!);
      stand.children.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, arch: () => stand.arch ?? actual.arch() };
});

const GO = { provider: "opencode-go", via: "login" } as const;

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-boot-"));
  vi.stubEnv("CHEAPAG_OPENCODE_URL", "");
  onTestFinished(() => {
    stopOpencode(true);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A health endpoint answering as the pinned OpenCode would; `authorizations` collects each request's header. */
async function health(authorizations: (string | undefined)[] = []) {
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.end(JSON.stringify({ healthy: true, version: OPENCODE_PIN }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("opencode serve exiting before it listens fails the boot with its exit code and output; nothing counts as running", async () => {
  const dir = projectDir();
  stand.script = 'console.error("boom: bad flag"); process.exit(3)';
  const boot = ensureOpencode(GO, dir);
  const running = runningOpencode(); // asked while the boot is still in flight
  await expect(boot).rejects.toThrow("opencode serve exited (3): boom: bad flag");
  expect(await running).toBeUndefined();
  expect(await runningOpencode()).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "stopOpencode ends the server's process group, and kills one that ignores the request after a grace period",
  async () => {
    const dir = projectDir();
    const url = await health();
    stand.script = `console.log("opencode server listening on ${url}"); setInterval(() => {}, 1000)`;
    expect(await ensureOpencode(GO, dir)).toMatchObject({ url, version: OPENCODE_PIN });
    expect((await runningOpencode())?.url).toBe(url);
    const polite = stand.pids.at(-1)!;
    stopOpencode();
    expect(await runningOpencode()).toBeUndefined();
    await vi.waitFor(() => expect(isAlive(polite)).toBe(false), slow(5_000));

    stand.script = `process.on("SIGTERM", () => {}); console.log("opencode server listening on ${url}"); setInterval(() => {}, 1000)`;
    await ensureOpencode(GO, dir);
    const stubborn = stand.pids.at(-1)!;
    stopOpencode();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(isAlive(stubborn)).toBe(true); // still within the grace period
    await vi.waitFor(() => expect(isAlive(stubborn)).toBe(false), {
      timeout: slow(6_000),
      interval: 100,
    });
  },
  slow(20_000),
);

test("with no OpenCode binary for this platform the error names it and says to reinstall", () => {
  expect(opencodeBinary()).toMatch(/opencode(\.exe)?$/);
  stand.arch = "nope";
  onTestFinished(() => void (stand.arch = undefined));
  expect(() => opencodeBinary()).toThrow(
    /^no OpenCode binary installed for opencode-\w+-nope; reinstall cheap-agent$/,
  );
});

/** Points this process's user config at a fresh home holding `config`. */
function userConfig(config: object) {
  const home = mkdtempSync(join(tmpdir(), "cheapag-boot-home-"));
  mkdirSync(join(home, "cheapag"), { recursive: true });
  writeFileSync(join(home, "cheapag", "config.json"), JSON.stringify(config));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("OLLAMA_API_KEY", "");
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
}

/** Resolves once `proc` has exited and its exit listeners, cheapag's first, have run. */
function exited(proc: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });
}

const LISTENING = (url: string) =>
  `console.log("opencode server listening on ${url}"); setInterval(() => {}, 1000)`;

/** Route model entries as the generated config writes them: the id as name, then `fields`. */
const named = (ids: string[], fields: object = {}) =>
  Object.fromEntries(ids.map((id) => [id, { name: id, ...fields }]));

const OPENROUTER_PRIVATE = {
  options: { provider: { data_collection: "deny", sort: "throughput" } },
};
const OLLAMA_CLOUD_MODELS = [
  "deepseek-v4.1-flash:cloud",
  "qwen3.8-flash:cloud",
  "glm-5.3:cloud",
  "glm-5.3-flash:cloud",
  "qwen3.7-plus:cloud",
];
const COMPATIBLE = "@ai-sdk/openai-compatible";

test.each([
  ["a built-in provider sets only the small model", "opencode-go", {}, {}],
  [
    "OpenRouter pins every route model's options",
    "openrouter",
    {},
    {
      openrouter: {
        models: Object.fromEntries(
          [
            "deepseek/deepseek-v4.1-flash",
            "qwen/qwen3.8-flash",
            "z-ai/glm-5.3-flash",
            "qwen/qwen3.7-plus",
            "z-ai/glm-5.3",
            "moonshotai/kimi-k3",
          ].map((id) => [id, OPENROUTER_PRIVATE]),
        ),
      },
    },
  ],
  [
    "Command Code is declared as an OpenAI-compatible provider",
    "commandcode",
    {},
    {
      commandcode: {
        npm: COMPATIBLE,
        name: "Command Code",
        options: { baseURL: "https://api.commandcode.ai/provider/v1" },
        models: named(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"]),
      },
    },
  ],
  [
    "Ollama Cloud: the default key variable, a context without an output limit, and prices",
    "ollama",
    { ollama: { endpoint: "cloud", context: 65536, price: { input: 0.5, output: 2 } } },
    {
      ollama: {
        npm: COMPATIBLE,
        name: "Ollama",
        options: { baseURL: "https://ollama.com/v1", apiKey: "{env:OLLAMA_API_KEY}" },
        models: named(OLLAMA_CLOUD_MODELS, {
          limit: { context: 65536, output: 16384 },
          cost: { input: 0.5, output: 2 },
        }),
      },
    },
  ],
  [
    "Ollama Cloud with its own key variable",
    "ollama",
    { ollama: { endpoint: "cloud", api_key_env: "MY_OLLAMA_KEY" } },
    {
      ollama: {
        npm: COMPATIBLE,
        name: "Ollama",
        options: { baseURL: "https://ollama.com/v1", apiKey: "{env:MY_OLLAMA_KEY}" },
        models: named(OLLAMA_CLOUD_MODELS),
      },
    },
  ],
  [
    "Ollama on this machine never sends a key, even with a key variable set",
    "ollama",
    {
      ollama: { endpoint: "local", model: "llama3.2", api_key_env: "UNUSED_KEY", context: 131072 },
    },
    {
      ollama: {
        npm: COMPATIBLE,
        name: "Ollama",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: named(["llama3.2"], { limit: { context: 131072, output: 32768 } }),
      },
    },
  ],
  [
    "a custom endpoint with a key file, both limits and prices",
    "local",
    {
      local: {
        base_url: "http://127.0.0.1:8084/v1",
        model: "qwen",
        api_key_file: "/keys/llama.key",
        context: 200000,
        output: 8192,
        price: { input: 0.27, output: 1.1 },
      },
    },
    {
      local: {
        npm: COMPATIBLE,
        name: "Custom endpoint",
        options: { baseURL: "http://127.0.0.1:8084/v1", apiKey: "{file:/keys/llama.key}" },
        models: named(["qwen"], {
          limit: { context: 200000, output: 8192 },
          cost: { input: 0.27, output: 1.1 },
        }),
      },
    },
  ],
  [
    "a custom endpoint with a key variable",
    "local",
    {
      local: {
        base_url: "https://gateway.example.com/v1",
        model: "qwen",
        api_key_env: "GATEWAY_KEY",
      },
    },
    {
      local: {
        npm: COMPATIBLE,
        name: "Custom endpoint",
        options: { baseURL: "https://gateway.example.com/v1", apiKey: "{env:GATEWAY_KEY}" },
        models: named(["qwen"]),
      },
    },
  ],
  [
    "a custom endpoint without a key",
    "local",
    { local: { base_url: "http://127.0.0.1:8084/v1", model: "qwen" } },
    {
      local: {
        npm: COMPATIBLE,
        name: "Custom endpoint",
        options: { baseURL: "http://127.0.0.1:8084/v1" },
        models: named(["qwen"]),
      },
    },
  ],
] as const)(
  "the generated opencode.json, byte for byte and in key order: %s",
  async (_, provider, config, providers) => {
    const dir = projectDir();
    userConfig(config);
    vi.stubEnv("CHEAPAG_OPENCODE_URL", await health());
    await ensureOpencode({ provider, via: "login" } as Provider, dir);
    const route = fullRoute(provider);
    const expected = {
      $schema: "https://opencode.ai/config.json",
      small_model: `${route.implement.providerID}/${route.implement.id}`,
      provider: providers,
    };
    expect(readFileSync(join(dir, ".cheapag", "opencode", "opencode.json"), "utf8")).toBe(
      JSON.stringify(expected, null, 2) + "\n",
    );
  },
);

test("Ollama with no endpoint configured throws at once, before anything is written or spawned", () => {
  const dir = projectDir();
  userConfig({ ollama: { endpoint: "cloud" } });
  const route = fullRoute("ollama");
  userConfig({});
  const spawned = stand.spawns.length;
  expect(() => ensureOpencode({ provider: "ollama", via: "config" }, dir, route)).toThrow(
    new Error("no Ollama endpoint configured; run cheapag login"),
  );
  expect(stand.spawns.length).toBe(spawned);
  expect(() => readFileSync(join(dir, ".cheapag", "opencode", "opencode.json"))).toThrow(/ENOENT/);
});

test("opencode serve runs on 127.0.0.1 at a free port in its own process group, with an env that isolates it; the health check sends its random password", async () => {
  const dir = projectDir();
  vi.stubEnv("CHEAPAG_OPENCODE_PASSWORD", "only-for-an-external-server");
  const authorizations: (string | undefined)[] = [];
  const url = await health(authorizations);
  stand.script = LISTENING(url);
  const opencode = await ensureOpencode(GO, dir);
  const { command, args, options } = stand.spawns.at(-1)!;
  expect(command).toBe(opencodeBinary());
  expect(args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expect(options).toMatchObject({
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const env = options.env!;
  const password = env.OPENCODE_SERVER_PASSWORD!;
  expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(opencode).toEqual({ url, password, version: OPENCODE_PIN });
  expect(Object.keys(env).slice(-6)).toEqual([
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DB",
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
    "OPENCODE_PERMISSION",
  ]);
  expect(env).toMatchObject({
    PATH: process.env.PATH,
    OPENCODE_CONFIG_DIR: join(dir, ".cheapag", "opencode"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: "cheapag-opencode.db",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_PERMISSION: JSON.stringify(baselinePermission()),
  });
  if (process.platform !== "win32") expect(env.SHELL).toBe(process.env.SHELL);
  expect(authorizations).toEqual([
    `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  ]);
});

test("an external OpenCode is reached with CHEAPAG_OPENCODE_PASSWORD, or a random password without it; nothing is spawned", async () => {
  const dir = projectDir();
  const authorizations: (string | undefined)[] = [];
  const url = await health(authorizations);
  vi.stubEnv("CHEAPAG_OPENCODE_URL", url);
  vi.stubEnv("CHEAPAG_OPENCODE_PASSWORD", "external-password");
  const spawned = stand.spawns.length;
  expect(await ensureOpencode(GO, dir)).toEqual({
    url,
    password: "external-password",
    version: OPENCODE_PIN,
  });
  stopOpencode(true);
  vi.stubEnv("CHEAPAG_OPENCODE_PASSWORD", "");
  const { password } = await ensureOpencode(GO, dir);
  expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(authorizations).toEqual([
    `Basic ${Buffer.from("opencode:external-password").toString("base64")}`,
    `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  ]);
  expect(stand.spawns.length).toBe(spawned);
});

test.skipIf(process.platform === "win32")(
  "opencode serve that never says it listens fails the boot after 15s and is stopped",
  async () => {
    const dir = projectDir();
    stand.script = "setInterval(() => {}, 1000)";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const boot = ensureOpencode(GO, dir);
    let failure: unknown;
    boot.catch((err: unknown) => (failure = err));
    const proc = stand.children.at(-1)!;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(boot).rejects.toThrow(new Error("opencode serve did not start within 15s"));
    await exited(proc);
    expect(proc.signalCode).toBe("SIGTERM");
    expect(await runningOpencode()).toBeUndefined();
  },
  slow(10_000),
);

test.skipIf(process.platform === "win32")(
  "stopOpencode(true), on process exit, kills a server that ignores SIGTERM at once",
  async () => {
    const dir = projectDir();
    const url = await health();
    stand.script = `process.on("SIGTERM", () => {}); ${LISTENING(url)}`;
    await ensureOpencode(GO, dir);
    const stubborn = stand.children.at(-1)!;
    const stoppedAt = Date.now();
    stopOpencode(true);
    expect(await runningOpencode()).toBeUndefined();
    await exited(stubborn);
    expect(stubborn.signalCode).toBe("SIGKILL");
    expect(Date.now() - stoppedAt).toBeLessThan(2_000); // well inside the 3s grace a plain stop waits
  },
  slow(10_000),
);

test.skipIf(process.platform === "win32")(
  "a server that dies after it listens is forgotten, so the next call boots a fresh one",
  async () => {
    const dir = projectDir();
    const url = await health();
    stand.script = LISTENING(url);
    await ensureOpencode(GO, dir);
    const crashed = stand.children.at(-1)!;
    crashed.kill("SIGKILL");
    await exited(crashed);
    expect(await runningOpencode()).toBeUndefined();
    await ensureOpencode(GO, dir);
    expect(stand.children.at(-1)).not.toBe(crashed);
    expect((await runningOpencode())?.url).toBe(url);
  },
  slow(10_000),
);

test.skipIf(process.platform === "win32")(
  "a changed model configuration reboots the server unless a job holds it; the old server's exit never stops its replacement",
  async () => {
    const dir = projectDir();
    const url = await health();
    stand.script = LISTENING(url);
    const balanced = fullRoute("opencode-go");
    const strongest = fullRoute("opencode-go", PRESETS["opencode-go"].strongest);
    const configFile = join(dir, ".cheapag", "opencode", "opencode.json");

    await ensureOpencode(GO, dir, balanced);
    const first = stand.children.at(-1)!;
    const spawned = stand.spawns.length;
    await ensureOpencode(GO, dir, balanced); // same configuration: same server
    await ensureOpencode(GO, dir); // no route: any running server will do
    expect(stand.spawns.length).toBe(spawned);

    const release = holdOpencode();
    const other = holdOpencode();
    onTestFinished(() => {
      release();
      other();
    });
    release();
    release(); // a second release is a no-op: `other` still holds the server
    await expect(ensureOpencode(GO, dir, strongest)).rejects.toThrow(
      new Error(
        "the model configuration changed (consent or cheapag.json models) while jobs are running; retry once they finish",
      ),
    );
    expect(stand.spawns.length).toBe(spawned);
    expect(JSON.parse(readFileSync(configFile, "utf8")).small_model).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );

    other();
    await ensureOpencode(GO, dir, strongest);
    const second = stand.children.at(-1)!;
    expect(second).not.toBe(first);
    expect(JSON.parse(readFileSync(configFile, "utf8")).small_model).toBe("opencode-go/glm-5.3");
    await exited(first);
    expect((await runningOpencode())?.url).toBe(url);
    await ensureOpencode(GO, dir, strongest);
    expect(stand.children.at(-1)).toBe(second);
    expect(second.exitCode).toBeNull();
  },
  slow(10_000),
);
