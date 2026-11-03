import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, localServer, userConfigFile, type LocalServer } from "./config.js";
import { detectProvider, LOGIN_COMMAND as LOGIN, PROVIDERS, providerLabel as label, redact, savedProviders, type Provider } from "./credentials.js";
import { ensureOpencode, opencodeBinary, stopOpencode } from "./opencode.js";
import { runCli } from "./platform.js";
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
// a local server may first have to load the model from disk (or wake from an idle unload)
const LOCAL_CHECK_TIMEOUT_MS = 300_000;
const LOCAL_URL = "http://127.0.0.1:8080/v1";

const CHOICES = [...PRESET_NAMES, "custom"] as const;
type Choice = (typeof CHOICES)[number];
const isChoice = (s: string): s is Choice => (CHOICES as readonly string[]).includes(s);

export async function login(args: string[] = [], { setup = false }: { setup?: boolean } = {}): Promise<number> {
  const out = (line = "") => process.stdout.write(redact(line) + "\n");
  const flag = args.length === 2 && args[0] === "--preset" ? args[1] : undefined;
  if (args.length && flag === undefined) {
    out(`✗ usage: cheapag login [--preset ${CHOICES.join("|")}]`);
    return 1;
  }
  if (flag !== undefined && !isChoice(flag)) {
    out(`✗ "${flag}" is not a preset; use one of ${CHOICES.join(", ")}; nothing changed`);
    return 1;
  }
  // `npx cheap-agent` with a login already saved is just an update: no questions, no key prompt
  if (setup && flag === undefined) {
    const saved = detectProvider();
    if (saved) {
      out(`Cheap Agent ${version} · already set up with ${label(saved.provider)} (${currentPreset(saved.provider) ?? "custom"})`);
      const code = await register(out, true);
      out(`Restart Claude Code to load it. To change provider or models: ${LOGIN}`);
      return code;
    }
  }
  if (!process.stdin.isTTY) {
    const saved = detectProvider();
    if (!saved) {
      out(`✗ ${LOGIN} needs an interactive terminal (the key is typed into a hidden prompt)`);
      return 1;
    }
    if (saved.provider === "local") {
      out(`No terminal to ask in: the local server stays as configured in ${userConfigFile()}`);
      return 0;
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
  PROVIDERS.forEach((p, i) => out(`  ${i + 1}) ${p.label}${p.id === "local" ? " (any OpenAI-compatible URL: llama.cpp, Strata, Ollama, LM Studio, vLLM, LiteLLM)" : ""}`));
  const answer = await ask(`Provider [1-${PROVIDERS.length}]: `);
  const picked = PROVIDERS[Number(answer) - 1];
  if (!picked) {
    out(`✗ "${answer}" is not one of 1-${PROVIDERS.length}; nothing changed`);
    return 1;
  }
  if (picked.id === "local") {
    if (flag) out("--preset does not apply to a local server: its model is asked for below");
    if (!(await localLogin(out))) return 1;
  } else {
    const preset = currentPreset(picked.id) ?? "balanced";
    let choice = flag ?? "";
    if (flag === undefined) {
      out("Worker models:");
      CHOICES.forEach((name, i) =>
        out(`  ${i + 1}) ${name}${name === "balanced" ? " (recommended)" : name === "custom" ? " (set models yourself in cheapag.json)" : ""}`),
      );
      const answer = await ask(`Models [1-${CHOICES.length}, Enter = ${preset}]: `);
      choice = answer ? (CHOICES[Number(answer) - 1] ?? answer) : preset;
    }
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
    if (!savePreset(picked.id, choice, out) || !dropLocal(out, picked.label)) return 1;
  }

  const provider: Provider = { provider: picked.id, via: picked.id === "local" ? "config" : "login" };
  const check = await liveCheck(provider);
  out(check.ok ? `✓ ${check.line}` : `✗ ${check.line}`);
  if (!check.ok) {
    const hint = regionHint(check.line);
    if (hint) out(hint);
  }
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
function savePreset(provider: Exclude<Provider["provider"], "local">, choice: Choice, out: (line?: string) => void) {
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

/**
 * Asks for the local server: its URL, the model (from the server's own /models list when it gives one), a key file if it
 * needs a key, and the context window (detected from llama.cpp's /props or LM Studio's API when they answer). Saves it as
 * the user config's `local`, other keys kept. The key file is only checked to exist: OpenCode reads it, Cheap Agent never does.
 */
async function localLogin(out: (line?: string) => void): Promise<boolean> {
  let current: LocalServer | undefined;
  try {
    current = localServer();
  } catch {} // a damaged entry is replaced
  out("e.g. llama.cpp http://127.0.0.1:8080/v1, Ollama http://127.0.0.1:11434/v1, LM Studio http://127.0.0.1:1234/v1");
  let base = ((await ask(`Server URL [Enter = ${current?.base_url ?? LOCAL_URL}]: `)) || current?.base_url || LOCAL_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(base)) {
    out(`✗ "${base}" is not an http(s) URL; nothing changed`);
    return false;
  }
  let listed = await listModels(base);
  // most servers serve the OpenAI API under /v1: accept the bare host too
  if (listed === "unreachable" && !/\/v1$/.test(base)) {
    const v1 = await listModels(`${base}/v1`);
    if (v1 !== "unreachable") [base, listed] = [`${base}/v1`, v1];
  }
  if (listed === "unreachable") out(`! ${base}/models did not answer; is the server running? Continuing, the live check will tell.`);

  const keep = current?.base_url === base ? current : undefined;
  const keyAnswer = await ask(`API key file, if the server needs a key [Enter = ${keep?.api_key_file ?? "none"}, "none" to clear]: `);
  const keyFile = keyAnswer === "none" ? undefined : keyAnswer ? keyAnswer.replace(/^~(?=$|[\\/])/, homedir()) : keep?.api_key_file;
  if (keyFile !== undefined && (!isAbsolute(keyFile) || !existsSync(keyFile))) {
    // not echoed: a key pasted here by mistake stays off the screen
    out("✗ no such file: give the absolute path of a file holding only the key; nothing changed");
    return false;
  }

  let model: string | undefined;
  if (Array.isArray(listed) && listed.length) {
    out("Models on this server:");
    listed.forEach((id, i) => out(`  ${i + 1}) ${id}`));
    const fallback = keep && listed.includes(keep.model) ? keep.model : listed[0];
    const answer = await ask(`Model [1-${listed.length} or an id, Enter = ${fallback}]: `);
    model = answer ? (listed[Number(answer) - 1] ?? answer) : fallback;
  } else {
    if (listed === "auth") out("The server wants a key to list its models; type the model id instead.");
    model = (await ask(`Model id, as the server names it${keep ? ` [Enter = ${keep.model}]` : ""}: `)) || keep?.model;
  }
  if (!model) {
    out("✗ no model given; nothing changed");
    return false;
  }

  const detected = await contextOf(base, model);
  const known = detected ?? (keep?.model === model ? keep.context : undefined);
  const ctxAnswer = await ask(`Context window in tokens${detected ? " (detected)" : ""} [Enter = ${known ?? "unknown"}]: `);
  const context = ctxAnswer ? Number(ctxAnswer.replace(/[_,]/g, "").replace(/k$/i, "000")) : known;
  if (context !== undefined && !(Number.isInteger(context) && context > 0)) {
    out(`✗ "${ctxAnswer}" is not a number of tokens; nothing changed`);
    return false;
  }
  if (context === undefined) out("! Context window unknown: OpenCode cannot compact a long job before the server rejects it. Set local.context later if jobs fail on long sessions.");

  const local: LocalServer = { base_url: base, model, ...(keyFile && { api_key_file: keyFile }), ...(context && { context }) };
  const file = userConfigFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...readUser(), local }, null, 2) + "\n");
  } catch (err) {
    out(`✗ ${file}: ${(err as Error).message}; local server not saved`);
    return false;
  }
  out(`✓ Local server: ${model} at ${base}, saved in ${file}`);
  return true;
}

/** The server's model ids from GET /models, "auth" when it wants a key for that, "unreachable" when it does not answer as an OpenAI API. */
async function listModels(base: string): Promise<string[] | "auth" | "unreachable"> {
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 401 || res.status === 403) return "auth";
    if (!res.ok) return "unreachable";
    const { data } = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(data)) return "unreachable";
    return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return "unreachable";
  }
}

/**
 * The context window one request gets, when the server says: llama.cpp's /props (its n_ctx is shared by the parallel
 * slots), else LM Studio's /api/v0/models. Undefined when neither answers without a key.
 */
async function contextOf(base: string, model: string): Promise<number | undefined> {
  const root = base.replace(/\/v1$/, "");
  const get = async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return res.ok ? ((await res.json()) as any) : undefined;
    } catch {
      return undefined;
    }
  };
  const props = await get(`${root}/props`);
  const nCtx = props?.default_generation_settings?.n_ctx;
  if (Number.isInteger(nCtx) && nCtx > 0) return Math.floor(nCtx / (Number.isInteger(props.total_slots) && props.total_slots > 0 ? props.total_slots : 1));
  const lms = await get(`${root}/api/v0/models`);
  const entry = Array.isArray(lms?.data) ? lms.data.find((m: any) => m?.id === model) : undefined;
  const loaded = entry?.loaded_context_length ?? entry?.max_context_length;
  return Number.isInteger(loaded) && loaded > 0 ? loaded : undefined;
}

/** After a login to a hosted provider: removes the user config's `local`, which would otherwise keep winning over it. */
function dropLocal(out: (line?: string) => void, provider: string) {
  try {
    const { local, ...rest } = readUser();
    if (local === undefined) return true;
    writeFileSync(userConfigFile(), JSON.stringify(rest, null, 2) + "\n");
    out(`✓ Local server setting removed from ${userConfigFile()}; ${provider} is used now`);
    return true;
  } catch (err) {
    out(`✗ ${userConfigFile()}: ${(err as Error).message}`);
    return false;
  }
}

/** One tiny real call to the implement model the user's config now picks, through the bundled OpenCode, in a throwaway directory. */
async function liveCheck(provider: Provider): Promise<{ ok: boolean; line: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-login-"));
  let name = provider.provider as string;
  let timer: NodeJS.Timeout | undefined;
  let timeoutMs = CHECK_TIMEOUT_MS;
  try {
    timeoutMs = provider.provider === "local" ? LOCAL_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS;
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
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs)));
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

/** The fix for OpenCode Go's Global-region error, when the live check hit it. */
export function regionHint(line: string): string | undefined {
  if (!line.includes("requires Global regions")) return undefined;
  return "  Fix: in the OpenCode console (opencode.ai), Settings → Privacy → Regions → Global; or pick a model that does not need it (e.g. opencode-go/glm-5.3-flash) with --preset custom.";
}

/** A one-line reason and fix for the common live-check failures. */
function explain(message: string, model: string) {
  const first = message.split("\n")[0];
  if (/\b401\b|unauthori[sz]ed|authentication|invalid.*key|api key/i.test(message)) return `the key was rejected (${first}); run ${LOGIN} again with the right key`;
  if (/\b402\b|credit|insufficient|balance|quota/i.test(message)) return `the account has no credit (${first}); top it up, then run ${LOGIN} again`;
  if (/ECONNREFUSED|fetch failed|unable to connect|connection refused/i.test(message)) return `could not reach the server for ${model} (${first}); start it, or run ${LOGIN} with the right URL`;
  if (/\b404\b|not found|no endpoints|not available/i.test(message)) return `${model} is unavailable to this account (${first}); run ${LOGIN} and pick another provider`;
  return `live check failed: ${first}`;
}

/**
 * Offers user-scope registration with Claude Code, then the plugin; prints the commands whenever it does not run them.
 * On an update, the plugin line says it was updated and the fresh-install closing line is left to the caller.
 */
async function register(out: (line?: string) => void, update = false): Promise<number> {
  const done = () => {
    const plugin = installPlugin(out, { update });
    if (!update) finish(out, plugin);
  };
  const command = serverCommand();
  const manual = `claude mcp add -s user cheapag -- ${command.map(quote).join(" ")}`;
  const remove = "claude mcp remove cheapag -s user";
  const existing = runCli("claude", ["mcp", "get", "cheapag"], { encoding: "utf8" });
  if (!existing) {
    out(`Claude Code's CLI was not found. To add cheapag for all your projects, run:\n  ${manual}`);
    return 0;
  }
  // only a user-scope entry counts: a local or project one doesn't cover "all your projects"
  if (existing.status === 0 && /Scope:\s*User/i.test(existing.stdout)) {
    if (sameCommand(registeredCommand(existing.stdout), command)) {
      out("✓ cheapag is already registered with Claude Code");
      done();
      return 0;
    }
    // an older version or path would keep running the old server: replace it without asking
    const removed = runCli("claude", ["mcp", "remove", "cheapag", "-s", "user"], { encoding: "utf8" });
    const added = removed?.status === 0 ? runCli("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], { encoding: "utf8" }) : undefined;
    if (removed?.status !== 0 || added?.status !== 0) {
      const failed = removed?.status === 0 ? added : removed;
      out(`✗ claude mcp update failed (${((failed?.stderr || failed?.stdout) ?? "").trim().split("\n")[0]}). Run it yourself:\n  ${remove}\n  ${manual}`);
      done();
      return 1;
    }
    out(`✓ Updated cheapag's server in Claude Code to ${version}`);
    done();
    return 0;
  }
  if (/^n/i.test(await ask("Add cheapag to Claude Code for all your projects? [Y/n] "))) {
    out(`Not registered. To add it later, run:\n  ${manual}`);
    return 0;
  }
  const added = runCli("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], { encoding: "utf8" });
  if (!added || added.status !== 0) {
    out(`✗ claude mcp add failed (${((added?.stderr || added?.stdout) ?? "").trim().split("\n")[0]}). Run it yourself:\n  ${manual}`);
    return 1;
  }
  out("✓ Added cheapag to Claude Code for all your projects");
  done();
  return 0;
}

/** The executable and arguments `claude mcp get cheapag` reports for the entry, or undefined when it shows neither. */
function registeredCommand(stdout: string): string[] | undefined {
  const command = /^\s*Command:\s*(.*?)\s*$/m.exec(stdout)?.[1];
  if (command === undefined) return undefined;
  const args = /^\s*Args:\s*(.*?)\s*$/m.exec(stdout)?.[1];
  return [command, ...(args ? args.split(/\s+/).filter(Boolean) : [])];
}

function sameCommand(existing: string[] | undefined, current: string[]) {
  return existing !== undefined && existing.length === current.length && existing.every((arg, i) => arg === current[i]);
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
  return entry.split(sep).includes("_npx") ? ["npx", "-y", `cheap-agent@${version}`] : [stableNode(), entry];
}

// double quotes on Windows: cmd and PowerShell don't treat single quotes as quoting
const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : process.platform === "win32" ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;

/** One question on a fresh readline, closed before anything else (OpenCode's login) reads the terminal. */
async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
