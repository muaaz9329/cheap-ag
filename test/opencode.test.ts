import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { callText, startServer } from "./harness.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; dependencies: Record<string, string> };
const PIN = pkg.dependencies["opencode-ai"];

/** Just enough of OpenCode to answer the startup health check. */
async function fakeHealth(version: string, status = 200) {
  const http = createServer((_, res) => {
    res.statusCode = status;
    res.end(JSON.stringify({ healthy: true, version }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  onTestFinished(() => void http.close());
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

async function pingWith(env: Record<string, string>, setup?: (home: string) => void) {
  const server = await startServer({ env });
  onTestFinished(server.close);
  setup?.(server.home);
  return callText(server.client, "ping");
}

/** Pids whose parent is `pid`; empty when none. */
function children(pid: number) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)]).toString().trim().split("\n").map(Number);
  } catch {
    return [];
  }
}

test("opencode-ai and its SDK are pinned to the same exact version", () => {
  expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies["@opencode-ai/sdk"]).toBe(PIN);
});

test.each([
  ["OpenCode login wins over both keys", true, { OPENCODE_GO_API_KEY: "go-key-value", DEEPSEEK_API_KEY: "ds-key-value" }, "provider=opencode-go via=login"],
  ["OPENCODE_GO_API_KEY wins over the other keys", false, { OPENCODE_GO_API_KEY: "go-key-value", OPENROUTER_API_KEY: "or-key-value", DEEPSEEK_API_KEY: "ds-key-value" }, "provider=opencode-go via=OPENCODE_GO_API_KEY"],
  ["OPENROUTER_API_KEY wins over DEEPSEEK_API_KEY", false, { OPENROUTER_API_KEY: "or-key-value", DEEPSEEK_API_KEY: "ds-key-value" }, "provider=openrouter via=OPENROUTER_API_KEY"],
  ["DEEPSEEK_API_KEY alone", false, { DEEPSEEK_API_KEY: "ds-key-value" }, "provider=deepseek via=DEEPSEEK_API_KEY"],
] as const)("credentials: %s", async (_, login, keys, expected) => {
  const text = await pingWith({ ...keys, CHEAPAG_OPENCODE_URL: await fakeHealth(PIN) }, (home) => {
    if (!login) return;
    mkdirSync(join(home, "data", "opencode"), { recursive: true });
    writeFileSync(join(home, "data", "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "login-key-value" } }));
  });
  expect(text).toBe(`OK cheapag ${pkg.version} opencode=${PIN} ${expected}`);
});

test("refuses with FAIL when the OpenCode server reports a different version", async () => {
  const text = await pingWith({ OPENCODE_GO_API_KEY: "go-key-value", CHEAPAG_OPENCODE_URL: await fakeHealth("0.0.1") });
  expect(text).toBe(`FAIL reason: opencode version 0.0.1, expected ${PIN}; reinstall cheap-agent`);
});

test("an alternative OpenCode that rejects the health check gives a clear FAIL", async () => {
  const url = await fakeHealth(PIN, 401);
  const text = await pingWith({ OPENCODE_GO_API_KEY: "go-key-value", CHEAPAG_OPENCODE_URL: url });
  expect(text).toBe(`FAIL reason: opencode health check at ${url} answered 401`);
});

test("key values never reach tool output or the generated config", async () => {
  const key = "sk-cheapagSECRET0123456789abcdef";
  // a server that echoes the key back forces the error path to carry it
  const server = await startServer({ env: { DEEPSEEK_API_KEY: key, CHEAPAG_OPENCODE_URL: await fakeHealth(key) } });
  onTestFinished(server.close);
  const text = await callText(server.client, "ping");
  expect(text).toContain("FAIL reason: opencode version [redacted]");
  expect(text).not.toContain(key);
  const configDir = join(server.home, ".cheapag", "opencode");
  const config = readFileSync(join(configDir, "opencode.json"), "utf8");
  expect(config).not.toContain(key);
  expect(JSON.parse(config).provider).toEqual({ deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" } } });
});

test("an OpenRouter key never reaches output or config; the config denies data collection and pins every model", async () => {
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
  // a version check that echoes the key forces it into the error path
  const server = await startServer({ env: { OPENROUTER_API_KEY: key, CHEAPAG_OPENCODE_URL: await fakeHealth(key) } });
  onTestFinished(server.close);
  const text = await callText(server.client, "ping");
  expect(text).toBe("FAIL reason: opencode version [redacted], expected 1.19.0; reinstall cheap-agent");
  const config = readFileSync(join(server.home, ".cheapag", "opencode", "opencode.json"), "utf8");
  expect(config).not.toContain(key);
  expect(JSON.parse(config)).toMatchObject({
    small_model: "openrouter/deepseek/deepseek-v4.1-flash",
    provider: {
      openrouter: {
        options: { apiKey: "{env:OPENROUTER_API_KEY}" },
        models: { "deepseek/deepseek-v4.1-flash": { options: { provider: { data_collection: "deny" } } } },
      },
    },
  });
});

test("boots the bundled OpenCode lazily on localhost, restarts it after a crash, and kills its process group on exit", async () => {
  // PATH without Homebrew & co: only the bundled binary can be found
  const PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  const server = await startServer({ env: { OPENCODE_GO_API_KEY: "go-key-value", PATH } });
  onTestFinished(server.close);

  expect(children(server.pid)).toEqual([]); // nothing started until first use
  const text = await callText(server.client, "ping");
  expect(text).toBe(`OK cheapag ${pkg.version} opencode=${PIN} provider=opencode-go via=OPENCODE_GO_API_KEY`);

  const [opencodePid] = children(server.pid);
  const listening = execFileSync("lsof", ["-a", "-p", String(opencodePid), "-iTCP", "-sTCP:LISTEN", "-nP"]).toString();
  expect(listening).toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
  expect(listening).not.toMatch(/\*:\d+ \(LISTEN\)/);

  const configDir = join(server.home, ".cheapag", "opencode");
  expect(readdirSync(configDir).sort()).toEqual(["agents", "opencode.json", "tools"]);

  // a crashed OpenCode is replaced on the next call, not reused
  process.kill(opencodePid, "SIGKILL");
  await vi.waitFor(() => expect(children(server.pid)).not.toContain(opencodePid));
  expect(await callText(server.client, "ping")).toMatch(/^OK /);
  const [restartedPid] = children(server.pid);
  expect(restartedPid).not.toBe(opencodePid);

  await server.close();
  await vi.waitFor(() => expect(() => execFileSync("pgrep", ["-g", String(restartedPid)])).toThrow(), { timeout: 5000 });
  await vi.waitFor(() => expect(() => execFileSync("pgrep", ["-g", String(opencodePid)])).toThrow(), { timeout: 5000 });
}, 30_000);
