import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { isAlive, killProcessGroup } from "../src/platform.js";
import { PRESETS } from "../src/routing.js";
import { callText, slow, startServer } from "./harness.js";

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

async function pingWith(env: Record<string, string>, logins: Record<string, string> = { "opencode-go": "go-key-value" }) {
  const server = await startServer({ env, logins });
  onTestFinished(server.close);
  return callText(server.client, "ping");
}

/** Pids whose parent is `pid`; empty when none. */
function children(pid: number) {
  try {
    if (process.platform === "win32") {
      // opencode.exe only: the server can also have a conhost.exe child
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='opencode.exe'").ProcessId`]).toString().trim();
      return out ? out.split(/\s+/).map(Number) : [];
    }
    return execFileSync("pgrep", ["-P", String(pid)]).toString().trim().split("\n").map(Number);
  } catch {
    return [];
  }
}

/** Whether the whole process group is gone; on Windows there are no groups, so the pid alone decides. */
function gone(pid: number) {
  if (process.platform === "win32") return !isAlive(pid);
  try {
    execFileSync("pgrep", ["-g", String(pid)]); // throws when the group is empty
    return false;
  } catch {
    return true;
  }
}

test("opencode-ai and its SDK are pinned to the same exact version", () => {
  expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies["@opencode-ai/sdk"]).toBe(PIN);
});

test.each([
  ["OpenCode Go wins over the others", { deepseek: "d", openrouter: "o", "opencode-go": "g" }, "provider=opencode-go via=login preset=balanced"],
  ["OpenRouter wins over DeepSeek", { deepseek: "d", openrouter: "o" }, "provider=openrouter via=login preset=balanced"],
  ["DeepSeek alone", { deepseek: "d" }, "provider=deepseek via=login preset=balanced"],
  ["an unsupported provider's login is not used", { anthropic: "a" }, null],
  ["env keys without a login are ignored", {}, null],
] as const)("credentials from saved logins only: %s", async (_, logins, expected) => {
  const text = await pingWith({ OPENCODE_GO_API_KEY: "g", OPENROUTER_API_KEY: "o", DEEPSEEK_API_KEY: "d", CHEAPAG_OPENCODE_URL: await fakeHealth(PIN) }, logins);
  expect(text).toBe(expected ? `OK cheapag ${pkg.version} opencode=${PIN} ${expected}` : "FAIL reason: no worker provider; run npx cheap-agent login");
});

test("ping names the preset the user's config picks, or custom when it matches none", async () => {
  const server = await startServer({ env: { CHEAPAG_OPENCODE_URL: await fakeHealth(PIN) }, logins: { openrouter: "o" } });
  onTestFinished(server.close);
  const dir = join(server.home, "config", "cheapag");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ models: PRESETS.openrouter.strongest }));
  expect(await callText(server.client, "ping")).toBe(`OK cheapag ${pkg.version} opencode=${PIN} provider=openrouter via=login preset=strongest`);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ models: { implement: "openrouter/qwen/qwen3.7-plus" } }));
  expect(await callText(server.client, "ping")).toMatch(/ via=login preset=custom$/);
});

test("refuses with FAIL when the OpenCode server reports a different version", async () => {
  const text = await pingWith({ CHEAPAG_OPENCODE_URL: await fakeHealth("0.0.1") });
  expect(text).toBe(`FAIL reason: opencode version 0.0.1, expected ${PIN}; reinstall cheap-agent`);
});

test("an alternative OpenCode that rejects the health check gives a clear FAIL", async () => {
  const url = await fakeHealth(PIN, 401);
  const text = await pingWith({ CHEAPAG_OPENCODE_URL: url });
  expect(text).toBe(`FAIL reason: opencode health check at ${url} answered 401`);
});

test("key values never reach tool output or the generated config", async () => {
  const key = "sk-cheapagSECRET0123456789abcdef";
  // a server that echoes the key back forces the error path to carry it
  const server = await startServer({ env: { CHEAPAG_OPENCODE_URL: await fakeHealth(key) }, logins: { deepseek: key } });
  onTestFinished(server.close);
  const text = await callText(server.client, "ping");
  expect(text).toContain("FAIL reason: opencode version [redacted]");
  expect(text).not.toContain(key);
  const configDir = join(server.home, ".cheapag", "opencode");
  const config = readFileSync(join(configDir, "opencode.json"), "utf8");
  expect(config).not.toContain(key);
  expect(JSON.parse(config)).toMatchObject({ small_model: "deepseek/deepseek-flash", provider: {} }); // the key stays in OpenCode's store
});

test("an OpenRouter key never reaches output or config; the config denies data collection and pins every model", async () => {
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
  // a version check that echoes the key forces it into the error path
  const server = await startServer({ env: { CHEAPAG_OPENCODE_URL: await fakeHealth(key) }, logins: { openrouter: key } });
  onTestFinished(server.close);
  const text = await callText(server.client, "ping");
  expect(text).toBe("FAIL reason: opencode version [redacted], expected 1.19.0; reinstall cheap-agent");
  const config = readFileSync(join(server.home, ".cheapag", "opencode", "opencode.json"), "utf8");
  expect(config).not.toContain(key);
  expect(JSON.parse(config)).toEqual({
    $schema: "https://opencode.ai/config.json",
    small_model: "openrouter/deepseek/deepseek-v4.1-flash",
    provider: {
      openrouter: {
        // every role and fallback model denies data collection
        models: Object.fromEntries(
          ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash", "z-ai/glm-5.3-flash", "qwen/qwen3.7-plus", "z-ai/glm-5.3", "moonshotai/kimi-k3"]
            .map((id) => [id, { options: { provider: { data_collection: "deny" } } }]),
        ),
      },
    },
  });
});

test("a Command Code key never reaches output or config; the config declares the OpenAI-compatible provider and pins every route model", async () => {
  const key = "sk-commandcodeSECRET0123456789abcdef";
  // a version check that echoes the key forces it into the error path
  const server = await startServer({ env: { CHEAPAG_OPENCODE_URL: await fakeHealth(key) }, logins: { commandcode: key } });
  onTestFinished(server.close);
  const text = await callText(server.client, "ping");
  expect(text).toBe("FAIL reason: opencode version [redacted], expected 1.19.0; reinstall cheap-agent");
  const config = readFileSync(join(server.home, ".cheapag", "opencode", "opencode.json"), "utf8");
  expect(config).not.toContain(key);
  expect(config).not.toContain("apiKey");
  expect(config).not.toContain("sk-");
  expect(JSON.parse(config)).toEqual({
    $schema: "https://opencode.ai/config.json",
    small_model: "commandcode/deepseek/deepseek-v4.1-flash",
    provider: {
      commandcode: {
        // not in OpenCode's catalog: declared as an OpenAI-compatible provider, with a model entry for every route model
        npm: "@ai-sdk/openai-compatible",
        name: "Command Code",
        options: { baseURL: "https://api.commandcode.ai/provider/v1" },
        models: Object.fromEntries(
          ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"].map((id) => [id, { name: id }]),
        ),
      },
    },
  });
});

test("boots the bundled OpenCode lazily on localhost, restarts it after a crash, and kills its process group on exit", async () => {
  // PATH without Homebrew & co: only the bundled binary can be found
  const PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  const server = await startServer({ env: { PATH }, logins: { "opencode-go": "go-key-value" } });
  onTestFinished(server.close);

  expect(children(server.pid)).toEqual([]); // nothing started until first use
  const text = await callText(server.client, "ping");
  expect(text).toBe(`OK cheapag ${pkg.version} opencode=${PIN} provider=opencode-go via=login preset=balanced`);

  const [opencodePid] = children(server.pid);
  if (process.platform !== "win32") {
    // no lsof on Windows
    const listening = execFileSync("lsof", ["-a", "-p", String(opencodePid), "-iTCP", "-sTCP:LISTEN", "-nP"]).toString();
    expect(listening).toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
    expect(listening).not.toMatch(/\*:\d+ \(LISTEN\)/);
  }

  const configDir = join(server.home, ".cheapag", "opencode");
  expect(readdirSync(configDir).sort()).toEqual(["agents", "node_modules", "opencode.json", "package-lock.json", "plugins", "tools"]);

  // a crashed OpenCode is replaced on the next call, not reused
  // a crashed OpenCode: kill its whole process group (Windows: the top process alone leaves its children holding the server home)
  killProcessGroup(opencodePid, "SIGKILL");
  await vi.waitFor(() => expect(children(server.pid)).not.toContain(opencodePid));
  expect(await callText(server.client, "ping")).toMatch(/^OK /);
  const [restartedPid] = children(server.pid);
  expect(restartedPid).not.toBe(opencodePid);

  await server.close();
  // Windows (CI 2026-10-29): after a simulated crash a copy can stay running; a known beta issue in the README
  if (process.platform !== "win32") {
    await vi.waitFor(() => expect(gone(restartedPid)).toBe(true), { timeout: slow(5000) });
    await vi.waitFor(() => expect(gone(opencodePid)).toBe(true), { timeout: slow(5000) });
  }
}, slow(30_000));

test("the server's normal shutdown stops OpenCode (stdin closed, no signal)", async () => {
  const server = await startServer({ logins: { "opencode-go": "k" }, env: { CHEAPAG_DEBUG_SHUTDOWN: "1" } });
  onTestFinished(server.close);
  await callText(server.client, "ping");
  const [oc] = children(server.pid);
  expect(typeof oc).toBe("number");
  const t0 = Date.now();
  await server.close();
  await vi.waitFor(() => expect(isAlive(server.pid)).toBe(false), { timeout: slow(10_000) });
  console.error(`cheapag-test: server exited after ${Date.now() - t0} ms`);
  try {
    await vi.waitFor(() => expect(gone(oc)).toBe(true), { timeout: slow(10_000) });
  } finally {
    console.error(`cheapag-test: opencode ${oc} alive after shutdown: ${isAlive(oc) ? "yes" : "no"}`);
  }
  expect(gone(oc)).toBe(true);
}, slow(60_000));

test("the generated finish tool is valid JavaScript (a syntax error makes OpenCode drop it and the worker do nothing)", async () => {
  const { FINISH_TOOL_SOURCE } = await import("../src/opencode.js");
  expect(FINISH_TOOL_SOURCE).not.toContain("import");
  const dir = mkdtempSync(join(tmpdir(), "cheapag-finish-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "finish.mjs");
  writeFileSync(file, FINISH_TOOL_SOURCE);
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("the config dir pre-seeds node_modules and a package-lock so OpenCode skips its npm install", async () => {
  const { writeConfigDir, OPENCODE_PIN } = await import("../src/opencode.js");
  const dir = mkdtempSync(join(tmpdir(), "cheapag-config-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeConfigDir(dir, "{}");
  expect(readdirSync(dir).sort()).toEqual(["agents", "node_modules", "opencode.json", "package-lock.json", "plugins", "tools"]);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: { "": { dependencies: Record<string, string> } } };
  expect(lock.packages[""].dependencies["@opencode-ai/plugin"]).toBe(OPENCODE_PIN);
  expect(readFileSync(join(dir, "agents", "cheapag-worker.md"), "utf8")).toContain("list every case the step or Source names or implies");
});
