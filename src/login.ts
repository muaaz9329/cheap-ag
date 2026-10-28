import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, userConfigFile } from "./config.js";
import { detectProvider, LOGIN_COMMAND as LOGIN, PROVIDERS, providerLabel as label, redact, savedProviders, type Provider } from "./credentials.js";
import { ensureOpencode, opencodeBinary, stopOpencode } from "./opencode.js";
import { isSupported, UNSUPPORTED_REASON } from "./platform.js";
import { installPlugin, stableNode } from "./install.js";
import { fullRoute, modelName, presetOf, PRESET_NAMES, PRESETS, type ModelsConfig } from "./routing.js";
import { runSession } from "./worker.js";

/**
 * `cheapag login`: the only setup (ADR-0004). Picks a provider, lets the bundled OpenCode's own login take the key
 * (hidden input, saved in OpenCode's store; Cheap Agent never sees it), live-checks it, then offers to register
 * the server with Claude Code at user scope and install the plugin (ticket 31). `npx cheap-agent` in a terminal runs it too.
 */

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const CHECK_TIMEOUT_MS = 90_000;

const CHOICES = [...PRESET_NAMES, "custom"] as const;
type Choice = (typeof CHOICES)[number];
const isChoice = (s: string): s is Choice => (CHOICES as readonly string[]).includes(s);

export async function login(args: string[] = []): Promise<number> {
  const out = (line = "") => process.stdout.write(redact(line) + "\n");
  if (!isSupported()) {
    out(`✗ ${UNSUPPORTED_REASON}`);
    return 1;
  }
  const flag = args.length === 2 && args[0] === "--preset" ? args[1] : undefined;
  if (args.length && flag === undefined) {
    out(`✗ usage: cheapag login [--preset ${CHOICES.join("|")}]`);
    return 1;
  }
  if (flag !== undefined && !isChoice(flag)) {
    out(`✗ "${flag}" is not a preset; use one of ${CHOICES.join(", ")}; nothing changed`);
    return 1;
  }
  if (!process.stdin.isTTY) {
    const saved = detectProvider();
    if (!saved) {
      out(`✗ ${LOGIN} needs an interactive terminal (the key is typed into a hidden prompt)`);
      return 1;
    }
    // no terminal to type a key into: only the worker models are set, for the provider already logged in (scripts, the benchmark)
    const choice = flag ?? currentPreset(saved.provider) ?? "balanced";
    if (!flag) out(`No terminal to ask in: worker models stay ${choice} for ${label(saved.provider)}; pass --preset to choose`);
    return savePreset(saved.provider, choice, out) ? 0 : 1;
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
  const preset = currentPreset(picked.id) ?? "balanced";
  const choice = flag ?? ((await ask(`Worker models: cheapest / balanced (recommended) / strongest [${preset}]: `)) || preset);
  if (!isChoice(choice)) {
    out(`✗ "${choice}" is not one of ${CHOICES.join(", ")}; nothing changed`);
    return 1;
  }

  // the bundled OpenCode prompts for the key with hidden input and saves it in its own credential store
  const saved = spawnSync(opencodeBinary(), ["auth", "login", "--provider", picked.id], { stdio: "inherit" });
  if (saved.status !== 0 || !savedProviders().includes(picked.id)) {
    out(`✗ ${picked.label} login was not saved; run ${LOGIN} to try again`);
    return 1;
  }
  if (!savePreset(picked.id, choice, out)) return 1;

  const provider: Provider = { provider: picked.id, via: "login" };
  const check = await liveCheck(provider);
  out(check.ok ? `✓ ${check.line}` : `✗ ${check.line}`);
  const active = detectProvider()!;
  if (active.provider !== provider.provider) out(`Note: ${label(active.provider)} is also saved and is used first.`);
  if (!check.ok) return 1; // the login stays saved; fix the cause and run login again

  await register(out);
  return 0;
}

/** The user-level config as written, so saving a preset keeps its other keys; {} when there is none. */
function readUser(): Record<string, unknown> {
  const file = userConfigFile();
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("must hold a JSON object");
  return value;
}

/** The preset the user's config holds, when it sets `models` (Enter keeps it); a damaged file counts as none. */
function currentPreset(provider: Provider["provider"]) {
  try {
    const { models } = readUser();
    return models ? presetOf(provider, models as ModelsConfig) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the preset as the user config's `models`, other keys kept; custom writes nothing. */
function savePreset(provider: Provider["provider"], choice: Choice, out: (line?: string) => void) {
  const file = userConfigFile();
  if (choice === "custom") {
    out(`Worker models: custom, nothing written; set "models" in a repo's cheapag.json, or in ${file} for every repo`);
    return true;
  }
  try {
    const config = { ...readUser(), models: PRESETS[provider][choice] };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  } catch (err) {
    out(`✗ ${file}: ${(err as Error).message}; worker models not saved`);
    return false;
  }
  out(`✓ Worker models: ${choice} (implement ${PRESETS[provider][choice].implement}), saved in ${file}`);
  return true;
}

/** One tiny real call to the implement model the user's config now picks, through the bundled OpenCode, in a throwaway directory. */
async function liveCheck(provider: Provider): Promise<{ ok: boolean; line: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-login-"));
  let name = provider.provider as string;
  let timer: NodeJS.Timeout | undefined;
  try {
    // the throwaway dir has no cheapag.json, so this is the user's config alone
    const route = fullRoute(provider.provider, loadConfig(dir).models);
    const model = route.implement;
    name = modelName(model);
    // with the route, OpenCode's config pins this model too (on OpenRouter: data collection denied)
    const run = ensureOpencode(provider, dir, route).then((opencode) =>
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

/** Offers user-scope registration with Claude Code, then the plugin; prints the commands whenever it does not run them. */
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
    out("✓ cheapag is already registered with Claude Code");
    finish(out, installPlugin(out));
    return;
  }
  if (/^n/i.test(await ask("Add cheapag to Claude Code for all your projects? [Y/n] "))) {
    out(`Not registered. To add it later, run:\n  ${manual}`);
    return;
  }
  const added = spawnSync("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], { encoding: "utf8" });
  if (added.status !== 0) {
    out(`✗ claude mcp add failed (${(added.stderr || added.stdout).trim().split("\n")[0]}). Run it yourself:\n  ${manual}`);
    return;
  }
  out("✓ Added cheapag to Claude Code for all your projects");
  finish(out, installPlugin(out));
}

/** The last thing setup says: how to start. */
function finish(out: (line?: string) => void, plugin: boolean) {
  out(plugin
    ? "\nDone. Open a new Claude Code session in your project and run /cheapag:allow once there; then ask for changes as usual."
    : "\nThe server is set up; add the plugin with the commands above, then open a new Claude Code session.");
}

/** How Claude Code should start this installed package: npx when run from npx's cache, else this exact file. */
function serverCommand() {
  const entry = realpathSync(process.argv[1]);
  return entry.includes("/_npx/") ? ["npx", "-y", `cheap-agent@${version}`] : [stableNode(), entry];
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
