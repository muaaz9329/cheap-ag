import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { PRESETS } from "../src/routing.js";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { hermeticHome, serverEntry, type Logins } from "./harness.js";

const KEY = "sk-or-v1-loginTESTkey0123456789abcdef";

/**
 * Runs `cheapag login` in a pseudo-terminal, as a developer would: picks OpenRouter, types KEY into the bundled
 * OpenCode's own hidden prompt, live-checks against the fake, then answers the registration question.
 * `claude` is a stub on PATH (`registered` decides what `claude mcp get cheapag` says), or absent.
 * The worker-models question gets `preset` (default: Enter) unless `args` passes --preset; `config` is the user config before.
 */
async function runLogin(opts: { claude: "registered" | "local" | "unregistered" | "absent"; register?: "y" | "n"; check?: Action[]; logins?: Logins; path?: string[]; preset?: string; args?: string[]; config?: object }) {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(...(opts.check ?? [{ usage: { cost: 0.0001 } }]));
  const { home, env } = hermeticHome(opts.logins);
  const config = join(home, "config", "cheapag", "config.json");
  if (opts.config) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify(opts.config));
  }
  const bin = join(home, "bin");
  const calls = join(home, "claude-calls.log");
  if (opts.claude !== "absent") {
    mkdirSync(bin);
    const scope = { registered: "User config (available in all your projects)", local: "Local config (private to you in this project)", unregistered: "" }[opts.claude];
    const get = scope ? `echo "cheapag:"; echo "  Scope: ${scope}"; exit 0` : "exit 1";
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1 $2" = "mcp get" ]; then ${get}; fi\nexit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  const steps = [
    { expect: "Provider", send: "2\r" },
    ...(opts.args ? [] : [{ expect: "Workermodels", send: `${opts.preset ?? ""}\r` }]),
    { expect: "EnteryourAPIkey", send: `${KEY}\r` },
    ...(opts.register ? [{ expect: "Y/n", send: `${opts.register}\r` }] : []),
  ];
  const spec = {
    cmd: [process.execPath, serverEntry, "login", ...(opts.args ?? [])],
    cwd: home,
    env: { ...env, CHEAPAG_OPENCODE_URL: fake.url, PATH: [bin, ...(opts.path ?? []), dirname(process.execPath), "/usr/bin", "/bin"].join(":"), TERM: "xterm" },
    steps,
    timeout: 60,
  };
  // async: the fake OpenCode lives in this process and must keep answering while login runs
  const { stdout: output } = await promisify(execFile)("python3", [join(import.meta.dirname, "pty-drive.py"), JSON.stringify(spec)], { encoding: "utf8" });
  const auth = join(home, "data", "opencode", "auth.json");
  return {
    output,
    exit: output.trim().split("\n").at(-1),
    claudeCalls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    saved: existsSync(auth) ? Object.keys(JSON.parse(readFileSync(auth, "utf8"))) : [],
    config: existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : undefined,
    fake,
  };
}

/** `cheapag login <args>` with no terminal (a script), already logged in to OpenRouter; returns exit, output and the user config after. */
async function scriptedLogin(args: string[]) {
  const { home, env } = hermeticHome({ openrouter: "k" });
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const r = await promisify(execFile)(process.execPath, [serverEntry, "login", ...args], { env, encoding: "utf8" }).catch((e) => e);
  const config = join(home, "config", "cheapag", "config.json");
  return { code: r.code ?? 0, stdout: r.stdout as string, config: existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : undefined, file: config };
}

const ADD = `mcp add -s user cheapag -- ${process.execPath} ${serverEntry}`;

test("login saves the key through the bundled OpenCode, live-checks it, and registers at user scope on yes", async () => {
  const r = await runLogin({ claude: "unregistered", register: "y" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.saved).toEqual(["openrouter"]);
  expect(r.output).toContain("✓ openrouter/deepseek/deepseek-v4.1-flash answered (cost $0.0001)");
  expect(r.output).toContain("✓ Added cheapag to Claude Code (user scope).");
  expect(r.claudeCalls).toEqual(["mcp get cheapag", ADD]);
  // the live check ran the implement model on the provider just saved
  expect(r.fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
  expect(r.output).not.toContain(KEY.slice(10)); // OpenCode masks the input; nothing echoes it
  // Enter on the worker-models question took balanced, the default
  expect(r.output).toContain("Worker models: cheapest / balanced (recommended) / strongest [balanced]");
  expect(r.config).toEqual({ models: PRESETS.openrouter.balanced });
}, 90_000);

test("picking strongest writes its models to the user config, and the live check runs its implement model", async () => {
  const r = await runLogin({ claude: "registered", preset: "strongest" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.config).toEqual({ models: PRESETS.openrouter.strongest });
  expect(r.fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "z-ai/glm-5.3" });
  expect(r.output).toContain("✓ openrouter/z-ai/glm-5.3 answered");
}, 90_000);

test("re-running login offers the current preset; Enter keeps it and the config's other keys", async () => {
  const r = await runLogin({ claude: "registered", config: { test_cmd: "make check", models: PRESETS.openrouter.strongest } });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("strongest [strongest]");
  expect(r.config).toEqual({ test_cmd: "make check", models: PRESETS.openrouter.strongest });
}, 90_000);

test("--preset sets the models without asking; an answer that is no preset changes nothing", async () => {
  const r = await runLogin({ claude: "registered", args: ["--preset", "cheapest"] });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).not.toContain("Worker models: cheapest / balanced");
  expect(r.config).toEqual({ models: PRESETS.openrouter.cheapest });
  const bad = await runLogin({ claude: "registered", preset: "fastest" });
  expect(bad.exit).toMatch(/^EXIT 1 UNMATCHED/); // never got to the key
  expect(bad.output).toContain('✗ "fastest" is not one of cheapest, balanced, strongest, custom; nothing changed');
  expect(bad.config).toBeUndefined();
}, 90_000);

test("without a terminal, login sets the preset for the saved provider: the flag, custom, the balanced fallback, a bad name", async () => {
  const strongest = await scriptedLogin(["--preset", "strongest"]);
  expect([strongest.code, strongest.config]).toEqual([0, { models: PRESETS.openrouter.strongest }]);
  expect(strongest.stdout).toBe(`✓ Worker models: strongest (implement openrouter/z-ai/glm-5.3), saved in ${strongest.file}\n`);

  const custom = await scriptedLogin(["--preset", "custom"]);
  expect([custom.code, custom.config]).toEqual([0, undefined]);
  expect(custom.stdout).toContain('Worker models: custom, nothing written; set "models" in a repo\'s cheapag.json');

  const fallback = await scriptedLogin([]);
  expect([fallback.code, fallback.config]).toEqual([0, { models: PRESETS.openrouter.balanced }]);
  expect(fallback.stdout.split("\n")[0]).toBe("No terminal to ask in: worker models stay balanced for OpenRouter; pass --preset to choose");

  for (const args of [["--preset", "fastest"], ["--preset"], ["--zdr"]]) {
    const bad = await scriptedLogin(args);
    expect([bad.code, bad.config]).toEqual([1, undefined]);
    expect(bad.stdout).toMatch(args[1] ? /^✗ "fastest" is not a preset; use one of cheapest, balanced, strongest, custom; nothing changed\n$/ : /^✗ usage: cheapag login \[--preset cheapest\|balanced\|strongest\|custom\]\n$/);
  }
});

test("registration uses a node symlink on PATH (e.g. Homebrew's bin) over the versioned binary path", async () => {
  const { home } = hermeticHome();
  const stable = join(home, "stable");
  mkdirSync(stable);
  symlinkSync(process.execPath, join(stable, "node"));
  const r = await runLogin({ claude: "unregistered", register: "y", path: [stable] });
  expect(r.claudeCalls).toEqual(["mcp get cheapag", `mcp add -s user cheapag -- ${join(stable, "node")} ${serverEntry}`]);
}, 90_000);

test("answering no prints the exact command instead of running it", async () => {
  const r = await runLogin({ claude: "unregistered", register: "n" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain(`Not registered. To add it later, run:\n  claude ${ADD}`);
  expect(r.claudeCalls).toEqual(["mcp get cheapag"]);
}, 90_000);

test("an existing registration is detected and skipped without asking", async () => {
  const r = await runLogin({ claude: "registered" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("✓ cheapag is already registered with Claude Code; skipping");
  expect(r.output).not.toContain("[Y/n]");
  expect(r.claudeCalls).toEqual(["mcp get cheapag"]);
}, 90_000);

test("a registration at another scope does not count: login still offers the user-scope add", async () => {
  const r = await runLogin({ claude: "local", register: "y" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.claudeCalls).toEqual(["mcp get cheapag", ADD]);
}, 90_000);

test("without the claude CLI, login prints the command to run", async () => {
  const r = await runLogin({ claude: "absent" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain(`Claude Code's CLI was not found. To add cheapag for all your projects, run:\n  claude ${ADD}`);
}, 90_000);

test("a failed live check explains the fix, keeps the saved login, and does not offer registration", async () => {
  const r = await runLogin({ claude: "unregistered", check: [{ error: { name: "APIError", message: "401 Missing Authentication header" } }] });
  expect(r.exit).toBe("EXIT 1");
  expect(r.output).toContain("✗ the key was rejected (401 Missing Authentication header); run npx cheap-agent login again with the right key");
  expect(r.saved).toEqual(["openrouter"]);
  expect(r.claudeCalls).toEqual([]);
}, 90_000);

test.each([
  ["no credit", "402 Insufficient credits", "✗ the account has no credit (402 Insufficient credits); top it up, then run npx cheap-agent login again"],
  ["an unavailable model", "404 No endpoints found for deepseek/deepseek-v4.1-flash", "✗ openrouter/deepseek/deepseek-v4.1-flash is unavailable to this account (404 No endpoints found for deepseek/deepseek-v4.1-flash); run npx cheap-agent login and pick another provider"],
] as const)("a live check failing on %s says why and what to do", async (_, message, expected) => {
  const r = await runLogin({ claude: "unregistered", check: [{ error: { name: "APIError", message } }] });
  expect(r.exit).toBe("EXIT 1");
  expect(r.output).toContain(expected);
}, 90_000);

test("login refuses a non-interactive stdin instead of hanging", async () => {
  const { env } = hermeticHome();
  const r = await promisify(execFile)(process.execPath, [serverEntry, "login"], { env, encoding: "utf8" }).catch((e) => e);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("✗ npx cheap-agent login needs an interactive terminal (the key is typed into a hidden prompt)\n");
});

test("re-running login adds a provider; the earlier one keeps precedence and that is said", async () => {
  const r = await runLogin({ claude: "registered", logins: { "opencode-go": "g" } });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("Currently using: OpenCode Go.");
  expect(r.output).toContain("Note: OpenCode Go is also saved and is used first.");
  expect(r.saved.sort()).toEqual(["opencode-go", "openrouter"]);
}, 90_000);
