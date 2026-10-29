import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { installPaths, writePlugin } from "../src/install.js";
import { normalisePath } from "../src/platform.js";
import { PRESETS } from "../src/routing.js";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { hermeticHome, serverEntry, slow, tempRepo, type Logins } from "./harness.js";

const KEY = "sk-or-v1-loginTESTkey0123456789abcdef";

/**
 * Runs `cheapag login` in a pseudo-terminal, as a developer would: picks OpenRouter, types KEY into the bundled
 * OpenCode's own hidden prompt, live-checks against the fake, then answers the registration question.
 * `claude` is a stub on PATH (`registered` decides what `claude mcp get cheapag` says), or absent.
 * The worker-models question gets `preset` (default: Enter) unless `args` passes --preset; `config` is the user config before.
 */
// the terminal-driven tests need python3 and a pty, which Windows lacks; the launcher and win32 generation tests still run there
const tty = test.skipIf(process.platform === "win32");

async function runLogin(opts: { claude: "registered" | "local" | "unregistered" | "absent"; register?: "y" | "n"; check?: Action[]; logins?: Logins; path?: string[]; preset?: string; args?: string[]; config?: object; plugin?: "installed" | "fails"; cmd?: string[] }) {
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
    // ticket 31: "plugin list" / "plugin marketplace list" name cheapag once installed; "plugin install" can fail
    const listed = opts.plugin === "installed" ? `if [ "$1 $2" = "plugin list" ]; then echo "  ❯ cheapag@cheapag"; fi\nif [ "$1 $2 $3" = "plugin marketplace list" ]; then echo "  ❯ cheapag"; fi\n` : "";
    const fails = opts.plugin === "fails" ? `if [ "$1 $2" = "plugin install" ]; then echo "Plugin not found" >&2; exit 1; fi\n` : "";
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1 $2" = "mcp get" ]; then ${get}; fi\n${listed}${fails}exit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
    if (process.platform === "win32") {
      // claude.cmd with the same branches; goto labels because parentheses in the echoed text would break an if block
      const cmd = [
        "@echo off",
        `>>"${calls}" echo %*`,
        `if "%1 %2"=="mcp get" goto get`,
        ...(opts.plugin === "installed" ? [`if "%1 %2"=="plugin list" echo   cheapag@cheapag`, `if "%1 %2 %3"=="plugin marketplace list" echo   cheapag`] : []),
        ...(opts.plugin === "fails" ? [`if "%1 %2"=="plugin install" goto fail`] : []),
        "exit /b 0",
        ":get",
        ...(scope ? ["echo cheapag:", `echo   Scope: ${scope}`, "exit /b 0"] : ["exit /b 1"]),
        ":fail",
        "echo Plugin not found 1>&2",
        "exit /b 1",
      ];
      writeFileSync(join(bin, "claude.cmd"), cmd.join("\r\n") + "\r\n");
    }
  }
  const steps = [
    { expect: "Provider", send: "2\r" },
    ...(opts.args ? [] : [{ expect: "Workermodels", send: `${opts.preset ?? ""}\r` }]),
    { expect: "EnteryourAPIkey", send: `${KEY}\r` },
    ...(opts.register ? [{ expect: "Y/n", send: `${opts.register}\r` }] : []),
  ];
  const spec = {
    cmd: opts.cmd ?? [process.execPath, serverEntry, "login", ...(opts.args ?? [])],
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
    marketplace: join(home, "config", "cheapag", "marketplace"),
    launcher: join(home, "config", "cheapag", "bin", "cheapag.cjs"),
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
/** The plugin steps on a machine without it (ticket 31). */
const PLUGIN = (marketplace: string) => ["plugin marketplace list", "plugin list", `plugin marketplace add ${marketplace}`, "plugin install cheapag@cheapag"];

tty("login saves the key through the bundled OpenCode, live-checks it, and registers at user scope on yes", async () => {
  const r = await runLogin({ claude: "unregistered", register: "y" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.saved).toEqual(["openrouter"]);
  expect(r.output).toContain("✓ openrouter/deepseek/deepseek-v4.1-flash answered (cost $0.0001)");
  expect(r.output).toContain("✓ Added cheapag to Claude Code for all your projects");
  expect(r.output).toContain("✓ Added the cheapag plugin to Claude Code");
  expect(r.output).toContain("Open a new Claude Code session in your project and run /cheapag:allow once there");
  expect(r.claudeCalls).toEqual(["mcp get cheapag", ADD, ...PLUGIN(r.marketplace)]);
  // the live check ran the implement model on the provider just saved
  expect(r.fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
  expect(r.output).not.toContain(KEY.slice(10)); // OpenCode masks the input; nothing echoes it
  // Enter on the worker-models question took balanced, the default
  expect(r.output).toContain("Worker models: cheapest / balanced (recommended) / strongest [balanced]");
  expect(r.config).toEqual({ models: PRESETS.openrouter.balanced });
}, slow(90_000));

tty("picking strongest writes its models to the user config, and the live check runs its implement model", async () => {
  const r = await runLogin({ claude: "registered", preset: "strongest" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.config).toEqual({ models: PRESETS.openrouter.strongest });
  expect(r.fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "z-ai/glm-5.3" });
  expect(r.output).toContain("✓ openrouter/z-ai/glm-5.3 answered");
}, slow(90_000));

tty("re-running login offers the current preset; Enter keeps it and the config's other keys", async () => {
  const r = await runLogin({ claude: "registered", config: { test_cmd: "make check", models: PRESETS.openrouter.strongest } });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("strongest [strongest]");
  expect(r.config).toEqual({ test_cmd: "make check", models: PRESETS.openrouter.strongest });
}, slow(90_000));

tty("--preset sets the models without asking; an answer that is no preset changes nothing", async () => {
  const r = await runLogin({ claude: "registered", args: ["--preset", "cheapest"] });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).not.toContain("Worker models: cheapest / balanced");
  expect(r.config).toEqual({ models: PRESETS.openrouter.cheapest });
  const bad = await runLogin({ claude: "registered", preset: "fastest" });
  expect(bad.exit).toMatch(/^EXIT 1 UNMATCHED/); // never got to the key
  expect(bad.output).toContain('✗ "fastest" is not one of cheapest, balanced, strongest, custom; nothing changed');
  expect(bad.config).toBeUndefined();
}, slow(90_000));

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

test.skipIf(process.platform === "win32")("registration uses a node symlink on PATH (e.g. Homebrew's bin) over the versioned binary path", async () => {
  const { home } = hermeticHome();
  const stable = join(home, "stable");
  mkdirSync(stable);
  symlinkSync(process.execPath, join(stable, "node"));
  const r = await runLogin({ claude: "unregistered", register: "y", path: [stable] });
  expect(r.claudeCalls.slice(0, 2)).toEqual(["mcp get cheapag", `mcp add -s user cheapag -- ${join(stable, "node")} ${serverEntry}`]);
  expect(readFileSync(r.launcher, "utf8")).toContain(JSON.stringify(serverEntry));
}, slow(90_000));

tty("answering no prints the exact command instead of running it", async () => {
  const r = await runLogin({ claude: "unregistered", register: "n" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain(`Not registered. To add it later, run:\n  claude ${ADD}`);
  expect(r.claudeCalls).toEqual(["mcp get cheapag"]);
}, slow(90_000));

tty("an existing registration is detected and kept without asking; the plugin is still installed", async () => {
  const r = await runLogin({ claude: "registered" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("✓ cheapag is already registered with Claude Code\n");
  expect(r.output).not.toContain("[Y/n]");
  expect(r.claudeCalls).toEqual(["mcp get cheapag", ...PLUGIN(r.marketplace)]);
}, slow(90_000));

tty("the plugin is generated from the package: hooks and commands call the launcher, no .mcp.json, its own marketplace", async () => {
  const r = await runLogin({ claude: "registered" });
  const plugin = join(r.marketplace, "cheapag");
  const hooks = readFileSync(join(plugin, "hooks", "hooks.json"), "utf8");
  expect(hooks).not.toContain("npx -y");
  expect(hooks).toContain(`node '${r.launcher}' hook guard`);
  expect(hooks).toContain(`node '${r.launcher}' hook result`);
  expect(hooks).toContain(`node '${r.launcher}' hook context`);
  expect(readFileSync(join(plugin, "skills", "allow", "SKILL.md"), "utf8")).toContain(`allowed-tools: Bash(node '${r.launcher}' allow) Bash(node '${r.launcher}' allow *)`);
  expect(existsSync(join(plugin, ".mcp.json"))).toBe(false); // the server is registered at user scope instead
  expect(JSON.parse(readFileSync(join(r.marketplace, ".claude-plugin", "marketplace.json"), "utf8"))).toMatchObject({ name: "cheapag", plugins: [{ name: "cheapag", source: "./cheapag" }] });
  // the launcher runs this install, falling back to the pinned npm version
  const launcher = readFileSync(r.launcher, "utf8");
  expect(launcher).toContain(JSON.stringify(serverEntry));
  expect(launcher).toMatch(/npx -y cheap-agent@\d+\.\d+\.\d+/);
  expect(launcher).toContain('process.argv[2] === "hook" && process.argv[3] === "guard"');
  expect(launcher).toContain("pathToFileURL");
  const context = await promisify(execFile)(process.execPath, [r.launcher, "hook", "context"], { encoding: "utf8" });
  expect(context.stdout).toContain('"hookEventName":"SessionStart"');
}, slow(90_000));

tty("re-running setup updates the plugin it installed; a failed plugin step prints the commands to run", async () => {
  const again = await runLogin({ claude: "registered", plugin: "installed" });
  expect(again.claudeCalls).toEqual(["mcp get cheapag", "plugin marketplace list", "plugin list", "plugin marketplace update cheapag", "plugin update cheapag@cheapag"]);
  const failed = await runLogin({ claude: "registered", plugin: "fails" });
  expect(failed.exit).toBe("EXIT 0");
  expect(failed.output).toContain(`✗ claude plugin install cheapag@cheapag failed (Plugin not found). Run these yourself:\n  claude plugin marketplace add ${failed.marketplace}\n  claude plugin install cheapag@cheapag`);
  expect(failed.output).toContain("add the plugin with the commands above");
}, slow(120_000));

tty("npx cheap-agent with no arguments in a terminal runs setup (Claude Code starts the server with a piped stdin)", async () => {
  const r = await runLogin({ claude: "registered", cmd: [process.execPath, serverEntry] });
  expect(r.output).toContain("Cheap Agent login");
  expect(r.exit).toBe("EXIT 0");
}, slow(90_000));

tty("a registration at another scope does not count: login still offers the user-scope add", async () => {
  const r = await runLogin({ claude: "local", register: "y" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.claudeCalls.slice(0, 2)).toEqual(["mcp get cheapag", ADD]);
}, slow(90_000));

tty("without the claude CLI, login prints the command to run", async () => {
  const r = await runLogin({ claude: "absent" });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain(`Claude Code's CLI was not found. To add cheapag for all your projects, run:\n  claude ${ADD}`);
}, slow(90_000));

tty("a failed live check explains the fix, keeps the saved login, and does not offer registration", async () => {
  const r = await runLogin({ claude: "unregistered", check: [{ error: { name: "APIError", message: "401 Missing Authentication header" } }] });
  expect(r.exit).toBe("EXIT 1");
  expect(r.output).toContain("✗ the key was rejected (401 Missing Authentication header); run npx cheap-agent login again with the right key");
  expect(r.saved).toEqual(["openrouter"]);
  expect(r.claudeCalls).toEqual([]);
}, slow(90_000));

tty.each([
  ["no credit", "402 Insufficient credits", "✗ the account has no credit (402 Insufficient credits); top it up, then run npx cheap-agent login again"],
  ["an unavailable model", "404 No endpoints found for deepseek/deepseek-v4.1-flash", "✗ openrouter/deepseek/deepseek-v4.1-flash is unavailable to this account (404 No endpoints found for deepseek/deepseek-v4.1-flash); run npx cheap-agent login and pick another provider"],
] as const)("a live check failing on %s says why and what to do", async (_, message, expected) => {
  const r = await runLogin({ claude: "unregistered", check: [{ error: { name: "APIError", message } }] });
  expect(r.exit).toBe("EXIT 1");
  expect(r.output).toContain(expected);
}, slow(90_000));

test("login refuses a non-interactive stdin instead of hanging", async () => {
  const { env } = hermeticHome();
  const r = await promisify(execFile)(process.execPath, [serverEntry, "login"], { env, encoding: "utf8" }).catch((e) => e);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("✗ npx cheap-agent login needs an interactive terminal (the key is typed into a hidden prompt)\n");
});

tty("re-running login adds a provider; the earlier one keeps precedence and that is said", async () => {
  const r = await runLogin({ claude: "registered", logins: { "opencode-go": "g" } });
  expect(r.exit).toBe("EXIT 0");
  expect(r.output).toContain("Currently using: OpenCode Go.");
  expect(r.output).toContain("Note: OpenCode Go is also saved and is used first.");
  expect(r.saved.sort()).toEqual(["opencode-go", "openrouter"]);
}, slow(90_000));

test("writePlugin on win32 emits double-quoted, forward-slash commands with no sh gate", () => {
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  let launcher: string, marketplace: string;
  try {
    launcher = installPaths().launcher;
    marketplace = writePlugin(serverEntry, process.execPath, "win32");
  } finally {
    process.env.XDG_CONFIG_HOME = prev;
  }
  const ref = `node "${normalisePath(launcher)}"`;
  const hooks = JSON.parse(readFileSync(join(marketplace, "cheapag", "hooks", "hooks.json"), "utf8"));
  expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`${ref} hook guard`); // no `r=$(git…)` prefix: the launcher gates
  expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe(`${ref} hook result`);
  expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(`${ref} hook context`);
  const allow = readFileSync(join(marketplace, "cheapag", "skills", "allow", "SKILL.md"), "utf8");
  expect(allow).toContain(`allowed-tools: Bash(${ref} allow) Bash(${ref} allow *)`);
  expect(allow).toContain(`!\`${ref} allow $ARGUMENTS\``);
  expect(allow).not.toContain("npx -y");
});

test("the launcher gates the guard hook itself: nothing without the repo flag, a deny decision with it", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  let launcher: string;
  try {
    launcher = installPaths().launcher;
    writePlugin(serverEntry, process.execPath);
  } finally {
    process.env.XDG_CONFIG_HOME = prev;
  }
  const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const input = JSON.stringify({ session_id: "s1", prompt_id: "p1", cwd: repo.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.txt", old_string: "x", new_string: big }, tool_use_id: "t" });
  const off = spawnSync(process.execPath, [launcher, "hook", "guard"], { cwd: repo.dir, env, input, encoding: "utf8" });
  expect(off.status).toBe(0);
  expect(off.stdout.trim()).toBe(""); // no flag: the launcher exits before importing the guard

  mkdirSync(join(repo.dir, ".cheapag"), { recursive: true });
  writeFileSync(join(repo.dir, ".cheapag", "hook.json"), JSON.stringify({ on: true }) + "\n");
  const on = spawnSync(process.execPath, [launcher, "hook", "guard"], { cwd: repo.dir, env, input, encoding: "utf8" });
  expect(on.status).toBe(0);
  expect(JSON.parse(on.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" }); // the real guard ran through the import
});
