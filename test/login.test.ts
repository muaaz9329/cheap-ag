import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { hermeticHome, serverEntry, type Logins } from "./harness.js";

const KEY = "sk-or-v1-loginTESTkey0123456789abcdef";

/**
 * Runs `cheapag login` in a pseudo-terminal, as a developer would: picks OpenRouter, types KEY into the bundled
 * OpenCode's own hidden prompt, live-checks against the fake, then answers the registration question.
 * `claude` is a stub on PATH (`registered` decides what `claude mcp get cheapag` says), or absent.
 */
async function runLogin(opts: { claude: "registered" | "local" | "unregistered" | "absent"; register?: "y" | "n"; check?: Action[]; logins?: Logins }) {
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(...(opts.check ?? [{ usage: { cost: 0.0001 } }]));
  const { home, env } = hermeticHome(opts.logins);
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
    { expect: "EnteryourAPIkey", send: `${KEY}\r` },
    ...(opts.register ? [{ expect: "Y/n", send: `${opts.register}\r` }] : []),
  ];
  const spec = {
    cmd: [process.execPath, serverEntry, "login"],
    cwd: home,
    env: { ...env, CHEAPAG_OPENCODE_URL: fake.url, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), TERM: "xterm" },
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
    fake,
  };
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
