import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  localServer,
  ollamaConfig,
  privateHost,
  userConfigFile,
  OLLAMA_CLOUD_URL,
  OLLAMA_KEY_ENV,
  OLLAMA_LOCAL_URL,
  type LocalServer,
  type OllamaConfig,
} from "./config.js";
import { ollamaModels, type CatalogModel } from "./catalog.js";
import {
  detectProvider,
  LOGIN_COMMAND as LOGIN,
  PROVIDERS,
  providerLabel as label,
  redact,
  savedProviders,
  type Provider,
} from "./credentials.js";
import { ensureOpencode, OPENCODE_DB, opencodeBinary, stopOpencode } from "./opencode.js";
import { firstLine, runCli } from "./platform.js";
import { select } from "./prompt.js";
import { installPlugin, stableNode } from "./install.js";
import {
  effectiveModels,
  fullRoute,
  localEndpoint,
  modelName,
  presetOf,
  PRESET_NAMES,
  PRESETS,
  ROLES,
  type ModelsConfig,
  type Preset,
} from "./routing.js";
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

type Output = (line?: string) => void;
type ProviderId = Provider["provider"];
type ProviderEntry = (typeof PROVIDERS)[number];

const PROVIDER_HINTS: Partial<Record<ProviderId, string>> = {
  local: "(any OpenAI-compatible URL: a local server, LiteLLM, Azure, a vendor's API)",
  ollama: "(this machine's Ollama with no key, or Ollama Cloud with OLLAMA_API_KEY)",
};

export async function login(
  args: string[] = [],
  { setup = false }: { setup?: boolean } = {},
): Promise<number> {
  const out = (line = "") => process.stdout.write(redact(line) + "\n");
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    out(parsed.error);
    return 1;
  }
  const { flag } = parsed;
  // `npx cheap-agent` with a login already saved is just an update: no questions, no key prompt
  if (setup && flag === undefined) {
    const saved = detectProvider();
    if (saved) return updateSetup(saved.provider, out);
  }
  if (!process.stdin.isTTY) return loginWithoutTerminal(flag, out);
  return loginInTerminal(flag, out);
}

/** The `--preset` choice login's arguments give, or the line saying why they are wrong. */
function parseArgs(args: string[]): { flag: Choice | undefined } | { error: string } {
  const flag = args.length === 2 && args[0] === "--preset" ? args[1] : undefined;
  if (args.length && flag === undefined)
    return { error: `✗ usage: cheapag login [--preset ${CHOICES.join("|")}]` };
  if (flag !== undefined && !isChoice(flag))
    return {
      error: `✗ "${flag}" is not a preset; use one of ${CHOICES.join(", ")}; nothing changed`,
    };
  return { flag };
}

/** Setup run again with a login saved: re-registers the server and updates the plugin, asking nothing. */
async function updateSetup(provider: ProviderId, out: Output): Promise<number> {
  if (!localEndpoint(provider)) migratePreset(provider, out);
  const preset = currentPreset(provider) ?? "custom";
  out(`Cheap Agent ${version} · already set up with ${label(provider)} (${preset})`);
  const code = await register(out, true);
  out(`Restart Claude Code to load it. To change provider or models: ${LOGIN}`);
  return code;
}

/**
 * No terminal to type a key into: only the worker models are set, for the provider already logged in (scripts, the
 * benchmark). A local endpoint has none to set and stays as configured.
 */
function loginWithoutTerminal(flag: Choice | undefined, out: Output): number {
  const saved = detectProvider();
  if (!saved) {
    out(`✗ ${LOGIN} needs an interactive terminal (the key is typed into a hidden prompt)`);
    return 1;
  }
  if (localEndpoint(saved.provider)) {
    const setting = label(saved.provider).toLowerCase();
    out(`No terminal to ask in: the ${setting} setting stays as configured in ${userConfigFile()}`);
    return 0;
  }
  migratePreset(saved.provider, out);
  const choice = flag ?? currentPreset(saved.provider) ?? "balanced";
  if (!flag)
    out(
      `No terminal to ask in: worker models stay ${choice} for ${label(saved.provider)}; pass --preset to choose`,
    );
  return savePreset(saved.provider, choice, out) ? 0 : 1;
}

/** The interactive login: pick a provider, set it up, live-check it, then offer to register the server. */
async function loginInTerminal(flag: Choice | undefined, out: Output): Promise<number> {
  // the live check's OpenCode runs in its own process group; take it down on Ctrl-C too
  process.on("exit", () => stopOpencode(true));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => process.exit(130));
  out("Cheap Agent login");
  const picked = await pickProvider(out);
  if (!(await setUpProvider(picked, flag, out))) return 1;

  // another provider set up earlier would otherwise keep winning: point the user config at the one just logged in to
  if (detectProvider()?.provider !== picked.id && !setUserKey("provider", picked.id, out)) return 1;
  const provider: Provider = {
    provider: picked.id,
    via: picked.id === "local" || picked.id === "ollama" ? "config" : "login",
  };
  const check = await liveCheck(provider);
  out(check.ok ? `✓ ${check.line}` : `✗ ${check.line}`);
  if (!check.ok) {
    const hint = regionHint(check.line);
    if (hint) out(hint);
    return 1; // the login stays saved; fix the cause and run login again
  }

  await register(out);
  return 0;
}

/** The provider menu: arrow keys or a number, Enter picks; the provider in use starts highlighted. */
async function pickProvider(out: Output): Promise<ProviderEntry> {
  const current = detectProvider();
  if (current)
    out(
      `Currently using: ${label(current.provider)}. Logging in again replaces or adds a provider.`,
    );
  const options = PROVIDERS.map((entry) => ({
    label: entry.label,
    hint: PROVIDER_HINTS[entry.id],
  }));
  const inUse = PROVIDERS.findIndex((entry) => entry.id === current?.provider);
  return PROVIDERS[await select("Provider:", options, Math.max(0, inUse))];
}

/** Runs the picked provider's own setup; false when it stopped, after saying why. */
async function setUpProvider(
  picked: ProviderEntry,
  flag: Choice | undefined,
  out: Output,
): Promise<boolean> {
  if (picked.id === "local") {
    if (flag) out("--preset does not apply to a local server: its model is asked for below");
    return localLogin(out);
  }
  if (picked.id === "ollama") return ollamaLogin(out, flag);
  return hostedLogin(picked, flag, out);
}

/** A hosted provider: the worker models, then the key, which the bundled OpenCode takes; false when either is not saved. */
async function hostedLogin(
  picked: ProviderEntry,
  flag: Choice | undefined,
  out: Output,
): Promise<boolean> {
  migratePreset(picked.id, out);
  const choice = await askPreset(picked.id, flag);

  // the bundled OpenCode prompts for the key with hidden input and saves it in its own credential store
  const saved = spawnSync(opencodeBinary(), ["auth", "login", "--provider", picked.id], {
    stdio: "inherit",
    env: { ...process.env, OPENCODE_DB },
  });
  if (saved.status !== 0 || !savedProviders().includes(picked.id)) {
    out(`✗ ${picked.label} login was not saved; run ${LOGIN} to try again`);
    return false;
  }
  return savePreset(picked.id, choice, out) && dropLocal(out, picked.label);
}

/** The user-level config as written, so saving a preset keeps its other keys; {} when there is none. */
function readUser(): Record<string, unknown> {
  const file = userConfigFile();
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("must hold a JSON object");
  return value;
}

/** Rewrites the user config from what it holds now; false, and said (with what was `unsaved`), when it cannot be read or written. */
function updateUser(
  change: (config: Record<string, unknown>) => Record<string, unknown>,
  out: Output,
  unsaved?: string,
) {
  const file = userConfigFile();
  try {
    const next = change(readUser());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch (err) {
    out(`✗ ${file}: ${(err as Error).message}${unsaved ? `; ${unsaved}` : ""}`);
    return false;
  }
}

/** The preset the user's config holds: its saved name, else what its `models` match (Enter keeps it); a damaged file counts as none. */
function currentPreset(provider: Provider["provider"]): Preset | "custom" | undefined {
  try {
    const { preset, models } = readUser();
    if (preset !== undefined) return preset as Preset;
    return models ? presetOf(provider, models as ModelsConfig) : undefined;
  } catch {
    return undefined;
  }
}

const CHOICE_HINTS: Partial<Record<Choice, string>> = {
  balanced: "(recommended)",
  custom: "(set models yourself in cheapag.json)",
};

/** The worker-models choice: `--preset` when given (login has checked it), else asked, starting on the provider's current preset. */
async function askPreset(
  provider: Provider["provider"],
  flag: Choice | undefined,
): Promise<Choice> {
  if (flag !== undefined) return flag;
  const preset = currentPreset(provider) ?? "balanced";
  return CHOICES[
    await select(
      "Worker models:",
      CHOICES.map((name) => ({ label: name, hint: CHOICE_HINTS[name] })),
      CHOICES.indexOf(preset),
    )
  ];
}

/** Writes the preset name as the user config's `preset`, other keys kept; an old equal `models` is dropped, custom writes nothing. */
function savePreset(provider: Provider["provider"], choice: Choice, out: Output) {
  // login asks a local endpoint for its model instead; this keeps the narrowing below honest
  if (provider === "local") throw new Error("a custom endpoint has no presets");
  const file = userConfigFile();
  if (choice === "custom") {
    out(
      `Worker models: custom, nothing written; set "models" in a repo's cheapag.json, or in ${file} for every repo`,
    );
    return true;
  }
  const saved = updateUser(
    (user) => {
      const config: Record<string, unknown> = { ...user, preset: choice };
      if (JSON.stringify(config.models) === JSON.stringify(PRESETS[provider][choice]))
        delete config.models;
      return config;
    },
    out,
    "worker models not saved",
  );
  if (!saved) return false;
  out(
    `✓ Worker models: ${choice} preset (implement ${PRESETS[provider][choice].implement}), saved in ${file}; follows new releases`,
  );
  return true;
}

/** Rewrites an old user config whose `models` exactly match a current preset to that preset's name; anything else is left alone. */
function migratePreset(provider: Provider["provider"], out: Output) {
  if (provider === "local") return;
  try {
    const config = readUser();
    if (config.preset !== undefined || config.models === undefined) return;
    // balanced first, as presetOf does: cheapest and balanced are often the same route
    const name = (["balanced", "cheapest", "strongest"] as const).find(
      (p) => JSON.stringify(config.models) === JSON.stringify(PRESETS[provider][p]),
    );
    if (!name) return;
    const { models: _models, ...rest } = config;
    writeFileSync(userConfigFile(), JSON.stringify({ ...rest, preset: name }, null, 2) + "\n");
    out(`✓ worker models: ${name} preset (follows new releases)`);
  } catch {} // a damaged config is reported by the config load
}

/**
 * Asks for the local server: its URL, the model (from the server's own /models list when it gives one), a key file if it
 * needs a key, and the context window (detected from llama.cpp's /props or LM Studio's API when they answer). Saves it as
 * the user config's `local`, other keys kept. The key file is only checked to exist: OpenCode reads it, Cheap Agent never does.
 * Each question's Enter keeps what is saved for the same URL (and, for the context and price, the same model).
 */
async function localLogin(out: Output): Promise<boolean> {
  const current = readSaved(localServer);
  out(
    "e.g. llama.cpp http://127.0.0.1:8080/v1, Ollama http://127.0.0.1:11434/v1, or a gateway's https://…/v1",
  );
  const server = await askServer(current, out);
  if (!server) return false;
  const { base, listed } = server;
  const keep = current?.base_url === base ? current : undefined;
  const keySetting = await askKey(keep, out);
  if (!keySetting) return false;
  const model = await askModel(listed, keep, out);
  if (!model) return false;
  const sameModel = keep?.model === model ? keep : undefined;
  const contextSetting = await askContext({ base, model, kept: sameModel?.context }, out);
  if (!contextSetting) return false;
  const priceSetting = await askPrice(sameModel?.price, out);
  if (!priceSetting) return false;

  const local: LocalServer = {
    base_url: base,
    model,
    ...keySetting,
    ...contextSetting,
    ...priceSetting,
  };
  if (!updateUser((user) => ({ ...user, local }), out, "local server not saved")) return false;
  out(`✓ Custom endpoint: ${model} at ${base}, saved in ${userConfigFile()}`);
  return true;
}

/** The saved entry `read` returns; undefined when there is none or it is damaged, since login replaces it. */
function readSaved<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Why `base` cannot be used, or undefined: not http(s), or plain http to a public host (`publicHttp` says why). */
function urlProblem(base: string, publicHttp: string): string | undefined {
  if (!/^https?:\/\/\S+$/.test(base)) return `✗ "${base}" is not an http(s) URL; nothing changed`;
  if (base.startsWith("http:") && !privateHost(base)) return publicHttp;
  return undefined;
}

type ModelList = string[] | "auth" | "unreachable";

/** The server URL and what its /models lists; undefined when the URL is refused, after saying why. */
async function askServer(
  current: LocalServer | undefined,
  out: Output,
): Promise<{ base: string; listed: ModelList } | undefined> {
  const answer = await ask(`Server URL [Enter = ${current?.base_url ?? LOCAL_URL}]: `);
  let base = (answer || current?.base_url || LOCAL_URL).replace(/\/+$/, "");
  const problem = urlProblem(
    base,
    `✗ plain http to a public host would send code and key unencrypted; use https (plain http is only for this machine or a private network); nothing changed`,
  );
  if (problem) {
    out(problem);
    return undefined;
  }
  let listed = await listModels(base);
  // most servers serve the OpenAI API under /v1: accept the bare host too
  if (listed === "unreachable" && !base.endsWith("/v1")) {
    const listedUnderV1 = await listModels(`${base}/v1`);
    if (listedUnderV1 !== "unreachable") [base, listed] = [`${base}/v1`, listedUnderV1];
  }
  if (listed === "unreachable")
    out(
      `! ${base}/models did not answer; is the server running? Continuing, the live check will tell.`,
    );
  return { base, listed };
}

type KeySetting = Pick<LocalServer, "api_key_file" | "api_key_env">;

/** The key: an environment variable name or a key file path, "none" for no key; undefined when refused, after saying why. */
async function askKey(keep: LocalServer | undefined, out: Output): Promise<KeySetting | undefined> {
  const keptKey = keep?.api_key_env ?? keep?.api_key_file;
  const answer = await ask(
    `API key, if the endpoint needs one: an environment variable name (e.g. MY_GATEWAY_KEY) or a key file path [Enter = ${keptKey ?? "none"}, "none" to clear]: `,
  );
  if (!answer) return keptKeySetting(keep);
  if (answer === "none") return {};
  // upper case only: a key pasted here by mistake (mixed case) must never be saved as a variable name
  if (/^[A-Z_][A-Z0-9_]{0,63}$/.test(answer)) {
    // only whether it is set: its value is OpenCode's to read
    if (!process.env[answer])
      out(
        `! ${answer} is not set in this shell; set it where Claude Code starts, or jobs will fail with a key error`,
      );
    return { api_key_env: answer };
  }
  const keyFile = answer.replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(keyFile) || !existsSync(keyFile)) {
    // not echoed: a key pasted here by mistake stays off the screen
    out(
      "✗ not an environment variable name and no such file: give a variable name, or the absolute path of a file holding only the key; nothing changed",
    );
    return undefined;
  }
  return { api_key_file: keyFile };
}

/** The key setting saved for this URL, as it was. */
function keptKeySetting(keep: LocalServer | undefined): KeySetting {
  return {
    ...(keep?.api_key_file && { api_key_file: keep.api_key_file }),
    ...(keep?.api_key_env && { api_key_env: keep.api_key_env }),
  };
}

/** The model: picked from the server's list, else typed; undefined when none is given, after saying so. */
async function askModel(
  listed: ModelList,
  keep: LocalServer | undefined,
  out: Output,
): Promise<string | undefined> {
  let model: string | undefined;
  if (Array.isArray(listed) && listed.length) {
    const fallback = keep && listed.includes(keep.model) ? keep.model : listed[0];
    const options = listed.map((id) => ({ label: id }));
    model = listed[await select("Model:", options, listed.indexOf(fallback))];
  } else {
    if (listed === "auth")
      out("The server wants a key to list its models; type the model id instead.");
    const enterHint = keep ? ` [Enter = ${keep.model}]` : "";
    model = (await ask(`Model id, as the server names it${enterHint}: `)) || keep?.model;
  }
  if (!model) {
    out("✗ no model given; nothing changed");
    return undefined;
  }
  return model;
}

/** The context window, detected when the server says; undefined when the answer is not a number of tokens. */
async function askContext(
  { base, model, kept }: { base: string; model: string; kept: number | undefined },
  out: Output,
): Promise<Pick<LocalServer, "context"> | undefined> {
  const detected = await contextOf(base, model);
  const known = detected ?? kept;
  const answer = await ask(
    `Context window in tokens${detected ? " (detected)" : ""} [Enter = ${known ?? "unknown"}]: `,
  );
  const context = answer ? Number(answer.replace(/[_,]/g, "").replace(/k$/i, "000")) : known;
  if (context !== undefined && !(Number.isInteger(context) && context > 0)) {
    out(`✗ "${answer}" is not a number of tokens; nothing changed`);
    return undefined;
  }
  if (context === undefined)
    out(
      "! Context window unknown: OpenCode cannot compact a long job before the server rejects it. Set local.context later if jobs fail on long sessions.",
    );
  return { ...(context && { context }) };
}

/** The price per million tokens, input/output; undefined when the answer is not two prices, after saying so. */
async function askPrice(
  kept: LocalServer["price"],
  out: Output,
): Promise<Pick<LocalServer, "price"> | undefined> {
  const shown = kept ? `${kept.input}/${kept.output}` : "none";
  const answer = await ask(
    `Price in USD per million tokens, input/output, for spend tracking and the cost cap [Enter = ${shown}]: `,
  );
  const priced = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(answer);
  if (answer && !priced) {
    out(`✗ "${answer}" is not input/output prices, e.g. 0.27/1.10; nothing changed`);
    return undefined;
  }
  const price = priced ? { input: Number(priced[1]), output: Number(priced[2]) } : kept;
  return { ...(price && { price }) };
}

/**
 * Asks for the Ollama endpoint (issue #27): this machine's daemon, no key, the models already pulled; or Ollama Cloud,
 * which reads the key from OLLAMA_API_KEY. Saves it as the user config's `ollama`, other keys kept. Login reads the key
 * only to list the cloud models; the config names the variable, and OpenCode resolves it for every job.
 */
async function ollamaLogin(out: Output, flag: Choice | undefined): Promise<boolean> {
  let current: OllamaConfig | undefined;
  try {
    current = ollamaConfig();
  } catch {} // a damaged entry is replaced
  // with only OLLAMA_API_KEY set, cloud is what the user came for; otherwise this machine is the likely pick
  const cloud = current?.endpoint === "cloud" || (!current && !!process.env[OLLAMA_KEY_ENV]);
  const endpoints = [
    {
      label: "This machine",
      hint: "(no key; the models you have pulled; nothing leaves the machine)",
    },
    { label: "Ollama Cloud", hint: `(ollama.com; the key in ${OLLAMA_KEY_ENV})` },
  ];
  return (await select("Ollama endpoint:", endpoints, cloud ? 1 : 0)) === 1
    ? cloudOllamaLogin(out, current, flag)
    : localOllamaLogin(out, current, flag);
}

/** Ollama on this machine: its URL, then one of the models `/api/tags` lists, with the context `/api/show` reports. */
async function localOllamaLogin(
  out: Output,
  current: OllamaConfig | undefined,
  flag: Choice | undefined,
): Promise<boolean> {
  if (flag)
    out("--preset does not apply to Ollama on this machine: it runs the one model asked for below");
  const keep = current?.endpoint === "local" ? current : undefined;
  const typed = (
    (await ask(`Ollama URL [Enter = ${keep?.base_url ?? OLLAMA_LOCAL_URL}]: `)) ||
    keep?.base_url ||
    OLLAMA_LOCAL_URL
  ).replace(/\/+$/, "");
  // the daemon's own API (/api/tags) is at the root; OpenCode wants the OpenAI-compatible /v1 under it
  const base = /^https?:\/\/[^/]+$/.test(typed) ? `${typed}/v1` : typed;
  if (!/^https?:\/\/\S+$/.test(base)) {
    out(`✗ "${base}" is not an http(s) URL; nothing changed`);
    return false;
  }
  // this machine's daemon is plain http; the same rule as a custom endpoint still keeps a public host on https
  if (base.startsWith("http:") && !privateHost(base)) {
    out(`✗ plain http to a public host would send code unencrypted; use https; nothing changed`);
    return false;
  }
  let listed: CatalogModel[];
  try {
    listed = await ollamaModels("local", base);
  } catch (err) {
    out(`✗ ${(err as Error).message}; nothing changed`);
    return false;
  }
  const preferred = keep && listed.some((m) => m.id === keep.model) ? keep.model : listed[0].id;
  const model =
    listed[
      await select(
        "Model:",
        listed.map((m) => ({
          label: m.id,
          hint: m.context ? `${Math.round(m.context / 1000)}k context` : undefined,
        })),
        Math.max(
          0,
          listed.findIndex((m) => m.id === preferred),
        ),
      )
    ].id;
  const reported =
    listed.find((m) => m.id === model)?.context ||
    (keep?.model === model ? keep.context : undefined);
  const context = reported && reported > 0 ? reported : undefined;
  if (!context)
    out(
      "! Ollama reported no context window for this model; set ollama.context later if long jobs are cut off",
    );
  const ollama: OllamaConfig = {
    endpoint: "local",
    base_url: base,
    model,
    ...(context && { context }),
  };
  if (!saveOllama(ollama, out) || !dropLocal(out, "Ollama")) return false;
  out(`✓ Ollama on this machine: ${model} at ${base}, saved in ${userConfigFile()}`);
  return true;
}

/** Ollama Cloud: the key must already be in the environment (never typed here), then the cloud presets are offered. */
async function cloudOllamaLogin(
  out: Output,
  current: OllamaConfig | undefined,
  flag: Choice | undefined,
): Promise<boolean> {
  const key = process.env[OLLAMA_KEY_ENV];
  if (!key) {
    out(
      `✗ ${OLLAMA_KEY_ENV} is not set in this shell; create a key at ollama.com, export it where Claude Code starts, then run ${LOGIN} again; nothing changed`,
    );
    return false;
  }
  // a custom base URL already saved (a proxy in front of Ollama Cloud) is kept, for the listing and the setting
  const base = (current?.endpoint === "cloud" ? current.base_url : OLLAMA_CLOUD_URL).replace(
    /\/+$/,
    "",
  );
  let listed: CatalogModel[];
  try {
    listed = await ollamaModels("cloud", base, key);
  } catch (err) {
    out(`✗ ${(err as Error).message}; nothing changed`);
    return false;
  }
  // the roles name cloud model ids: say what this account cannot see now, instead of failing job after job
  const wanted = [
    ...new Set([...ROLES.ollama.implement, ...ROLES.ollama.research, ROLES.ollama.escalation]),
  ];
  const missing = wanted.filter((id) => !listed.some((m) => m.id === id));
  if (missing.length)
    out(
      `! Ollama Cloud does not list ${missing.join(", ")}; if a job fails, set "models" in ${userConfigFile()}`,
    );

  migratePreset("ollama", out);
  const choice = await askPreset("ollama", flag);
  const ollama: OllamaConfig = { endpoint: "cloud", base_url: base, api_key_env: OLLAMA_KEY_ENV };
  if (!saveOllama(ollama, out) || !savePreset("ollama", choice, out) || !dropLocal(out, "Ollama"))
    return false;
  out(`✓ Ollama Cloud: key from ${OLLAMA_KEY_ENV}, saved in ${userConfigFile()}`);
  return true;
}

/** Writes the user config's `ollama`, other keys kept; true when saved. */
function saveOllama(ollama: OllamaConfig, out: Output) {
  return updateUser((user) => ({ ...user, ollama }), out, "Ollama setting not saved");
}

/** The server's model ids from GET /models, "auth" when it wants a key for that, "unreachable" when it does not answer as an OpenAI API. */
async function listModels(base: string): Promise<ModelList> {
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
  if (Number.isInteger(nCtx) && nCtx > 0)
    return Math.floor(
      nCtx / (Number.isInteger(props.total_slots) && props.total_slots > 0 ? props.total_slots : 1),
    );
  const lms = await get(`${root}/api/v0/models`);
  const entry = Array.isArray(lms?.data) ? lms.data.find((m: any) => m?.id === model) : undefined;
  const loaded = entry?.loaded_context_length ?? entry?.max_context_length;
  return Number.isInteger(loaded) && loaded > 0 ? loaded : undefined;
}

/** Sets one key of the user config, other keys kept; undefined removes it. False (and said) when the file cannot be written. */
export function setUserKey(key: string, value: unknown, out: (line?: string) => void) {
  return updateUser(
    ({ [key]: _removed, ...rest }) => (value === undefined ? rest : { ...rest, [key]: value }),
    out,
  );
}

/** After a login to a hosted provider: removes the user config's `local`, which would otherwise keep winning over it. */
function dropLocal(out: Output, provider: string) {
  try {
    const { local, ...rest } = readUser();
    if (local === undefined) return true;
    writeFileSync(userConfigFile(), JSON.stringify(rest, null, 2) + "\n");
    out(`✓ Custom endpoint setting removed from ${userConfigFile()}; ${provider} is used now`);
    return true;
  } catch (err) {
    out(`✗ ${userConfigFile()}: ${(err as Error).message}`);
    return false;
  }
}

/** One tiny real call to the implement model the user's config now picks, through the bundled OpenCode, in a throwaway directory. */
export async function liveCheck(provider: Provider): Promise<{ ok: boolean; line: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-login-"));
  let name = provider.provider as string;
  let timer: NodeJS.Timeout | undefined;
  let timeoutMs = CHECK_TIMEOUT_MS;
  try {
    // a local model may first have to load from disk, and Ollama on this machine unloads it when idle
    timeoutMs = localEndpoint(provider.provider) ? LOCAL_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS;
    // the throwaway dir has no cheapag.json, so this is the user's config alone
    const route = fullRoute(provider.provider, effectiveModels(provider.provider, loadConfig(dir)));
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
    const timeout = new Promise<never>(
      (_, reject) =>
        (timer = setTimeout(
          () => reject(new Error(`no answer within ${timeoutMs / 1000}s`)),
          timeoutMs,
        )),
    );
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
  if (/\b401\b|unauthori[sz]ed|authentication|invalid.*key|api key/i.test(message))
    return `the key was rejected (${first}); run ${LOGIN} again with the right key`;
  if (/\b402\b|credit|insufficient|balance|quota/i.test(message))
    return `the account has no credit (${first}); top it up, then run ${LOGIN} again`;
  if (/ECONNREFUSED|fetch failed|unable to connect|connection refused/i.test(message))
    return `could not reach the server for ${model} (${first}); start it, or run ${LOGIN} with the right URL`;
  if (/\b404\b|not found|no endpoints|not available/i.test(message))
    return `${model} is unavailable to this account (${first}); run ${LOGIN} and pick another provider`;
  return `live check failed: ${first}`;
}

/**
 * Offers user-scope registration with Claude Code, then the plugin; prints the commands whenever it does not run them.
 * On an update, the plugin line says it was updated and the fresh-install closing line is left to the caller.
 */
async function register(out: Output, update = false): Promise<number> {
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
    const removed = runCli("claude", ["mcp", "remove", "cheapag", "-s", "user"], {
      encoding: "utf8",
    });
    const added =
      removed?.status === 0
        ? runCli("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], {
            encoding: "utf8",
          })
        : undefined;
    if (removed?.status !== 0 || added?.status !== 0) {
      const failed = removed?.status === 0 ? added : removed;
      out(
        `✗ claude mcp update failed (${firstLine(failed)}). Run it yourself:\n  ${remove}\n  ${manual}`,
      );
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
  const added = runCli("claude", ["mcp", "add", "-s", "user", "cheapag", "--", ...command], {
    encoding: "utf8",
  });
  if (!added || added.status !== 0) {
    out(`✗ claude mcp add failed (${firstLine(added)}). Run it yourself:\n  ${manual}`);
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
  return (
    existing !== undefined &&
    existing.length === current.length &&
    existing.every((arg, i) => arg === current[i])
  );
}

/** The last thing setup says: how to start. */
function finish(out: Output, plugin: boolean) {
  out(
    plugin
      ? "\nDone. Open a new Claude Code session in your project and run /cheapag:allow once there; then ask for changes as usual."
      : "\nThe server is set up; add the plugin with the commands above, then open a new Claude Code session.",
  );
}

/** How Claude Code should start this installed package: npx when run from npx's cache, else this exact file. */
function serverCommand() {
  const entry = realpathSync(process.argv[1]);
  return entry.split(sep).includes("_npx")
    ? ["npx", "-y", `cheap-agent@${version}`]
    : [stableNode(), entry];
}

// double quotes on Windows: cmd and PowerShell don't treat single quotes as quoting
function quote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (process.platform === "win32") return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** One question on a fresh readline, closed before anything else (OpenCode's login) reads the terminal. */
async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
