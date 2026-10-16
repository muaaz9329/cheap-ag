import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { detectProvider, LOGIN_COMMAND as LOGIN, PROVIDERS, providerLabel as label, redact, savedProviders, type Provider } from "./credentials.js";
import { ensureOpencode, opencodeBinary, stopOpencode } from "./opencode.js";
import { isSupported, UNSUPPORTED_REASON } from "./platform.js";
import { implementModel, modelName } from "./routing.js";
import { runSession } from "./worker.js";

/**
 * `cheapag login`: the only setup (ADR-0004). Picks a provider, lets the bundled OpenCode's own login take the key
 * (hidden input, saved in OpenCode's store; Cheap Agent never sees it), live-checks it, then offers to register
 * the server with Claude Code at user scope.
 */

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const CHECK_TIMEOUT_MS = 90_000;

export async function login(): Promise<number> {
  const out = (line = "") => process.stdout.write(redact(line) + "\n");
  if (!isSupported()) {
    out(`✗ ${UNSUPPORTED_REASON}`);
    return 1;
  }
  if (!process.stdin.isTTY) {
    out(`✗ ${LOGIN} needs an interactive terminal (the key is typed into a hidden prompt)`);
    return 1;
  }
  // the live check's OpenCode runs in its own process group; take it down on Ctrl-C too
  process.on("exit", () => stopOpencode(true));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(130));
  out("Cheap Agent login");
  const current = detectProvider();
  if (current) out(`Currently using: ${label(current.provider)}. Logging in again replaces or adds a provider.`);
  PROVIDERS.forEach((p, i) => out(`  ${i + 1}) ${p.label}`));
  const answer = await ask(`Provider [1-${PROVIDERS.length}]: `);
  const picked = PROVIDERS[Number(answer) - 1];
  if (!picked) {
    out(`✗ "${answer}" is not one of 1-${PROVIDERS.length}; nothing changed`);
    return 1;
  }

  // the bundled OpenCode prompts for the key with hidden input and saves it in its own credential store
  const saved = spawnSync(opencodeBinary(), ["auth", "login", "--provider", picked.id], { stdio: "inherit" });
  if (saved.status !== 0 || !savedProviders().includes(picked.id)) {
    out(`✗ ${picked.label} login was not saved; run ${LOGIN} to try again`);
    return 1;
  }

  const provider: Provider = { provider: picked.id, via: "login" };
  const check = await liveCheck(provider);
  out(check.ok ? `✓ ${check.line}` : `✗ ${check.line}`);
  const active = detectProvider()!;
  if (active.provider !== provider.provider) out(`Note: ${label(active.provider)} is also saved and is used first.`);
  if (!check.ok) return 1; // the login stays saved; fix the cause and run login again

  await register(out);
  return 0;
}

/** One tiny real call to the implement model, through the bundled OpenCode, in a throwaway directory. */
async function liveCheck(provider: Provider): Promise<{ ok: boolean; line: string }> {
  const model = implementModel(provider.provider);
  const name = modelName(model);
  const dir = mkdtempSync(join(tmpdir(), "cheapag-login-"));
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = ensureOpencode(provider, dir).then((opencode) =>
      runSession({
        opencode,
        directory: dir,
        model: { providerID: model.providerID, id: model.id },
        prompt: "Live check: reply with the single word OK. Do not use any tools.",
        onEvent: () => {},
      }),
    );
    // covers boot as well as the answer; on timeout, stopping OpenCode below ends the session, and login exits
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer within 90s")), CHECK_TIMEOUT_MS)));
    const result = await Promise.race([run, timeout]);
    if (result.error) return { ok: false, line: explain(result.error, name) };
    return { ok: true, line: `${name} answered (cost $${result.usage.costUsd.toFixed(4)})` };
  } catch (err) {
    return { ok: false, line: explain((err as Error).message, name) };
  } finally {
    clearTimeout(timer);
    stopOpencode();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A one-line reason and fix for the common live-check failures. */
function explain(message: string, model: string) {
  const first = message.split("\n")[0];
  if (/\b401\b|unauthori[sz]ed|authentication|invalid.*key|api key/i.test(message)) return `the key was rejected (${first}); run ${LOGIN} again with the right key`;
  if (/\b402\b|credit|insufficient|balance|quota/i.test(message)) return `the account has no credit (${first}); top it up, then run ${LOGIN} again`;
  if (/\b404\b|not found|no endpoints|not available/i.test(message)) return `${model} is unavailable to this account (${first}); run ${LOGIN} and pick another provider`;
  return `live check failed: ${first}`;
}

/** Offers user-scope registration with Claude Code; prints the command whenever it does not run it. */
async function register(out: (line?: string) => void) {
  const command = serverCommand();
  const manual = `claude mcp add -s user cheapag -- ${command.map(quote).join(" ")}`;
  const existing = spawnSync("claude", ["mcp", "get", "cheapag"], { encoding: "utf8" });
  if (existing.error) {
    out(`Claude Code's CLI was not found. To add cheapag for all your projects, run:\n  ${manual}`);
    return;
  }
  // only a user-scope entry counts: a local or project one doesn't cover "all your projects"
  // shortcut: an existing user-scope entry is kept even if it points at an older install; re-register by hand after moving it
  if (existing.status === 0 && /Scope:\s*User/i.test(existing.stdout)) {
    out("✓ cheapag is already registered with Claude Code; skipping");
    return;
  }
  if (/^n/i.test(await ask("Add cheapag to Claude Code for all your projects? [Y/n] "))) {
    out(`Not registered. To add it later, run:\n  ${manual}`);
    return;
  }
  const added = spawnSync("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], { encoding: "utf8" });
  if (added.status === 0) out("✓ Added cheapag to Claude Code (user scope). Start a new Claude Code session to use it.");
  else out(`✗ claude mcp add failed (${(added.stderr || added.stdout).trim().split("\n")[0]}). Run it yourself:\n  ${manual}`);
}

/** How Claude Code should start this installed package: npx when run from npx's cache, else this exact file. */
function serverCommand() {
  const entry = realpathSync(process.argv[1]);
  return entry.includes("/_npx/") ? ["npx", "-y", `cheap-agent@${version}`] : [stableNode(), entry];
}

/** A `node` on PATH resolving to this same binary (e.g. Homebrew's bin symlink) survives upgrades; the versioned execPath doesn't. */
function stableNode() {
  const self = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      if (dir && realpathSync(join(dir, "node")) === self) return join(dir, "node");
    } catch {} // no node in this PATH entry
  }
  return process.execPath;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** One question on a fresh readline, closed before anything else (OpenCode's login) reads the terminal. */
async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
