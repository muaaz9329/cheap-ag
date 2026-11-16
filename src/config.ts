import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PRESET_NAMES, type ModelsConfig, type Preset } from "./routing.js";

/** Optional settings: the repo's `cheapag.json` overrides the user's `~/.config/cheapag/config.json` (spec E4). */
export type Config = {
  test_cmd?: string; integration_cmd?: string; link_dirs: string[]; allow_commands: string[]; limits: Limits; retention: Retention;
  models: ModelsConfig; preset?: Preset; escalation_skip_at: number; guard_lines: number; hard_tasks: HardTasks; takeover: TakeOver;
};
/** Who implements a hard task (ticket 26): the worker on `models.hard`, Claude itself, or Claude's own Sonnet subagent. */
export const HARD_TASKS = ["delegate", "self", "sonnet"] as const;
export type HardTasks = (typeof HARD_TASKS)[number];
/** Who finishes a step the worker could not (tickets 30, 51): ask the user, a Sonnet subagent, or Claude itself within limits.takeover_calls. */
export const TAKE_OVER = ["sonnet", "self", "ask"] as const;
export type TakeOver = (typeof TAKE_OVER)[number];
/** Per-job caps, counted across the whole job: first run, self-fixes and escalation (spec: Models and limits); `max_parallel` bounds a batch's concurrent groups; `max_blocked_minutes` bounds a wait for `reply`. */
export type Limits = { max_turns: number; max_minutes: number; max_cost_usd: number; max_parallel: number; max_blocked_minutes: number; repro_by_turns: number; takeover_calls: number };
/** How long cleanup keeps an unlanded worktree and a job folder, in days (spec A20). */
export type Retention = { unlanded_worktree_days: number; job_log_days: number };

const DEFAULTS: Config = {
  link_dirs: ["node_modules", ".venv", "venv", "vendor"], allow_commands: ["npx tsc --noEmit"],
  limits: { max_turns: 25, max_minutes: 20, max_cost_usd: 0.5, max_parallel: 3, max_blocked_minutes: 60, repro_by_turns: 30, takeover_calls: 15 },
  retention: { unlanded_worktree_days: 2, job_log_days: 7 },
  models: {}, // the provider's role defaults (src/routing.ts)
  escalation_skip_at: 0.8,
  guard_lines: 20,
  hard_tasks: "delegate",
  takeover: "ask",
};
// build output is never linked: a job must build its own (ADR-0003)
const BUILD_OUTPUT = /^(dist|build|out|\.next|\.nuxt|target|coverage)$/;

/** The user-level config every repo's `cheapag.json` overrides; `cheapag login` writes its `preset`. */
export const userConfigFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cheapag", "config.json");

/**
 * A custom OpenAI-compatible endpoint for the worker: a local server (llama.cpp, Strata, Ollama, LM Studio, vLLM) or a
 * hosted gateway (LiteLLM, Azure, any vendor's OpenAI-compatible API): `local` in the
 * user config only, so a repo's cheapag.json can never point the worker at another endpoint. `model` is the server's
 * model id; `api_key_file` names a file and `api_key_env` an environment variable OpenCode reads the key from (Cheap Agent
 * never reads either); `context` and `output`
 * are the model's token limits, which OpenCode needs to compact a long session before the server rejects it.
 */
export type LocalServer = {
  base_url: string; model: string; api_key_file?: string; api_key_env?: string; context?: number; output?: number;
  /** USD per million tokens, for spend tracking and the job cost cap; without it a job's cost reads $0. */
  price?: { input: number; output: number };
};

/**
 * Ollama, one provider id with two endpoints (issue #27): a local server that needs no key, or Ollama Cloud at
 * ollama.com, whose key comes from an environment variable. `model` is the local endpoint's model (there is no
 * catalog to default from); the cloud endpoint uses the provider's role defaults and presets.
 */
export type OllamaConfig = {
  endpoint: "local" | "cloud";
  /** Local endpoint only: the model to run, e.g. "llama3.2". */
  model?: string;
  base_url: string;
  /** Cloud endpoint only: the variable OpenCode reads the key from (default OLLAMA_API_KEY). */
  api_key_env?: string;
  context?: number;
  output?: number;
  price?: { input: number; output: number };
};

const OLLAMA_URLS = { local: "http://127.0.0.1:11434/v1", cloud: "https://ollama.com/v1" } as const;
export const OLLAMA_KEY_ENV = "OLLAMA_API_KEY";
export const OLLAMA_LOCAL_URL = OLLAMA_URLS.local;
export const OLLAMA_CLOUD_URL = OLLAMA_URLS.cloud;

/** Whether a URL's host is this machine or a private network (where plain http is fine): loopback, RFC 1918, CGNAT, link-local, *.local, single-label names and home LAN suffixes. */
export function privateHost(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return true;
  if (host.includes(":")) return /^f[cd]/.test(host) || host.startsWith("fe80:"); // IPv6 unique-local and link-local
  if (!host.includes(".")) return true; // single-label machine names, e.g. gpu-box
  if (/\.(lan|home|internal|home\.arpa)$/.test(host)) return true;
  const ip = host.split(".").map(Number);
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = ip;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** The provider `cheapag provider` (or a login) picked, from the user config; undefined when none is set or the file is damaged. */
export function chosenProvider(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(userConfigFile(), "utf8")) as { provider?: unknown };
    return typeof value?.provider === "string" ? value.provider : undefined;
  } catch {
    return undefined;
  }
}

/** The user config's `local` server, undefined when none is set; throws on a damaged one. */
export function localServer(): LocalServer | undefined {
  const file = userConfigFile();
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as { local?: unknown };
  return value?.local === undefined ? undefined : parseLocal(value.local, file);
}

function parseLocal(local: unknown, file: string): LocalServer {
  if (typeof local !== "object" || local === null || Array.isArray(local)) throw new Error(`${file}: local must be an object`);
  const { base_url, model, api_key_file, api_key_env, context, output, price } = local as Record<string, unknown>;
  if (typeof base_url !== "string" || !/^https?:\/\/\S+$/.test(base_url)) throw new Error(`${file}: local.base_url must be an http(s) URL, e.g. http://127.0.0.1:8080/v1`);
  if (typeof model !== "string" || !model.trim()) throw new Error(`${file}: local.model must be the server's model id`);
  if (api_key_file !== undefined && (typeof api_key_file !== "string" || !isAbsolute(api_key_file))) throw new Error(`${file}: local.api_key_file must be an absolute path`);
  if (api_key_env !== undefined && (typeof api_key_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(api_key_env))) throw new Error(`${file}: local.api_key_env must be an environment variable name, e.g. MY_GATEWAY_KEY`);
  if (api_key_file !== undefined && api_key_env !== undefined) throw new Error(`${file}: local takes api_key_file or api_key_env, not both`);
  const p = price as { input?: unknown; output?: unknown } | undefined;
  if (p !== undefined && (typeof p !== "object" || p === null || ![p.input, p.output].every((v) => typeof v === "number" && v >= 0))) throw new Error(`${file}: local.price must be { "input": <USD per million tokens>, "output": <USD per million tokens> }`);
  for (const [key, v] of [["context", context], ["output", output]] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v <= 0)) throw new Error(`${file}: local.${key} must be a positive whole number of tokens`);
  }
  return {
    base_url: base_url.replace(/\/+$/, ""), model: model.trim(),
    ...(api_key_file !== undefined && { api_key_file }), ...(api_key_env !== undefined && { api_key_env: api_key_env as string }),
    ...(p !== undefined && { price: { input: p.input as number, output: p.output as number } }), ...(context !== undefined && { context: context as number }), ...(output !== undefined && { output: output as number }),
  };
}

function parseOllama(raw: unknown, file: string): OllamaConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file}: ollama must be an object`);
  const { endpoint, model, base_url, api_key_env, context, output, price } = raw as Record<string, unknown>;
  if (endpoint !== "local" && endpoint !== "cloud") throw new Error(`${file}: ollama.endpoint must be "local" or "cloud"`);
  const defaults = OLLAMA_URLS[endpoint];
  const base = base_url === undefined ? defaults : base_url;
  if (typeof base !== "string" || !/^https?:\/\/\S+$/.test(base)) throw new Error(`${file}: ollama.base_url must be an http(s) URL, e.g. ${defaults}`);
  if (base.startsWith("http:") && !privateHost(base)) throw new Error(`${file}: ollama.base_url with plain http must be this machine or a private network; use https`);
  if (endpoint === "local" && (typeof model !== "string" || !model.trim())) throw new Error(`${file}: ollama.model must be the local server's model id, e.g. "llama3.2"`);
  if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new Error(`${file}: ollama.model must be a model id`);
  const keyEnv = api_key_env ?? (endpoint === "cloud" ? OLLAMA_KEY_ENV : undefined);
  if (keyEnv !== undefined && (typeof keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))) throw new Error(`${file}: ollama.api_key_env must be an environment variable name, e.g. ${OLLAMA_KEY_ENV}`);
  const p = price as { input?: unknown; output?: unknown } | undefined;
  if (p !== undefined && (typeof p !== "object" || p === null || ![p.input, p.output].every((v) => typeof v === "number" && v >= 0))) throw new Error(`${file}: ollama.price must be { "input": <USD per million tokens>, "output": <USD per million tokens> }`);
  for (const [key, v] of [["context", context], ["output", output]] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v <= 0)) throw new Error(`${file}: ollama.${key} must be a positive whole number of tokens`);
  }
  return {
    endpoint, base_url: base.replace(/\/+$/, ""), ...(model !== undefined && { model: (model as string).trim() }),
    ...(keyEnv !== undefined && { api_key_env: keyEnv }),
    ...(p !== undefined && { price: { input: p.input as number, output: p.output as number } }),
    ...(context !== undefined && { context: context as number }), ...(output !== undefined && { output: output as number }),
  };
}

/** The user config's Ollama endpoint, undefined when none is set; throws on a damaged entry. */
export function ollamaConfig(): OllamaConfig | undefined {
  const file = userConfigFile();
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as { ollama?: unknown };
  return value?.ollama === undefined ? undefined : parseOllama(value.ollama, file);
}

/**
 * The endpoint the worker uses: the configured `ollama` block, else Ollama Cloud when OLLAMA_API_KEY is set (the key
 * alone is an implicit opt-in). Undefined when neither; a damaged entry throws, as `localServer` does.
 */
export function ollamaEndpoint(): OllamaConfig | undefined {
  const configured = ollamaConfig();
  if (configured) return configured;
  if (!process.env[OLLAMA_KEY_ENV]) return undefined;
  return { endpoint: "cloud", base_url: OLLAMA_URLS.cloud, api_key_env: OLLAMA_KEY_ENV };
}

export function loadConfig(root: string): Config {
  const [mine, repo] = [read(userConfigFile()), read(join(root, "cheapag.json"))];
  // caps, retention and models merge key by key, so a repo can set one and keep the user's others
  return {
    ...DEFAULTS, ...mine, ...repo,
    limits: { ...DEFAULTS.limits, ...mine.limits, ...repo.limits },
    retention: { ...DEFAULTS.retention, ...mine.retention, ...repo.retention },
    models: { ...mine.models, ...repo.models },
  };
}

function read(file: string): Partial<Omit<Config, "limits" | "retention">> & { limits?: Partial<Limits>; retention?: Partial<Retention> } {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} must hold a JSON object`);
  const { test_cmd, integration_cmd, link_dirs, allow_commands, limits, retention, models, escalation_skip_at, guard_lines, hard_tasks, takeover, local, ollama, preset, provider } = value as Record<string, unknown>;
  if (provider !== undefined) {
    if (file !== userConfigFile()) throw new Error(`${file}: provider can only be set in ${userConfigFile()}`);
    if (typeof provider !== "string") throw new Error(`${file}: provider must be a provider id, e.g. opencode-go; switch with cheapag provider`);
  }
  if (local !== undefined) {
    if (file !== userConfigFile()) throw new Error(`${file}: local can only be set in ${userConfigFile()}, never in a repo`);
    parseLocal(local, file);
  }
  if (ollama !== undefined) {
    if (file !== userConfigFile()) throw new Error(`${file}: ollama can only be set in ${userConfigFile()}, never in a repo`);
    parseOllama(ollama, file);
  }
  if (preset !== undefined) {
    if (file !== userConfigFile()) throw new Error(`${file}: preset can only be set in ${userConfigFile()}`);
    if (!PRESET_NAMES.includes(preset as Preset)) throw new Error(`${file}: preset must be one of ${PRESET_NAMES.join(", ")}`);
  }
  if (limits !== undefined && (typeof limits !== "object" || limits === null || Array.isArray(limits))) throw new Error(`${file}: limits must be an object`);
  const caps: Partial<Limits> = {};
  // E4's self_fix_attempts is not read yet
  for (const key of ["max_turns", "max_minutes", "max_cost_usd", "max_parallel", "max_blocked_minutes", "repro_by_turns", "takeover_calls"] as const) {
    const v = (limits as Record<string, unknown> | undefined)?.[key];
    if (v === undefined) continue;
    const whole = key === "max_turns" || key === "max_parallel" || key === "repro_by_turns" || key === "takeover_calls";
    // takeover_calls 0 turns the take-over budget off (ticket 29)
    const min = key === "takeover_calls" ? 0 : Number.MIN_VALUE;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (whole && !Number.isInteger(v))) {
      throw new Error(`${file}: limits.${key} must be a ${min ? "positive" : "non-negative"} ${whole ? "whole number" : "number"}`);
    }
    caps[key] = v;
  }
  if (retention !== undefined && (typeof retention !== "object" || retention === null || Array.isArray(retention))) throw new Error(`${file}: retention must be an object`);
  const keep: Partial<Retention> = {};
  for (const key of ["unlanded_worktree_days", "job_log_days"] as const) {
    const v = (retention as Record<string, unknown> | undefined)?.[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${file}: retention.${key} must be a number of days (0 or more)`);
    keep[key] = v;
  }
  if (allow_commands !== undefined && (!Array.isArray(allow_commands) || allow_commands.some((c) => typeof c !== "string" || !c.trim()))) {
    throw new Error(`${file}: allow_commands must be a list of commands`);
  }
  if (models !== undefined && (typeof models !== "object" || models === null || Array.isArray(models))) throw new Error(`${file}: models must be an object`);
  const roles = (models ?? {}) as Record<string, unknown>;
  const name = (v: unknown) => typeof v === "string" && /^[\w.-]+\/\S+$/.test(v);
  for (const role of ["implement", "medium", "hard", "research", "escalation"]) {
    if (roles[role] !== undefined && !name(roles[role])) throw new Error(`${file}: models.${role} must be a provider/model name, e.g. opencode-go/deepseek-v4.1-flash`);
  }
  if (roles.fallback !== undefined && (!Array.isArray(roles.fallback) || !roles.fallback.every(name))) throw new Error(`${file}: models.fallback must be a list of provider/model names`);
  if (roles.variants !== undefined) {
    const variants = roles.variants;
    if (typeof variants !== "object" || variants === null || Array.isArray(variants) || Object.values(variants).some((v) => typeof v !== "string")) {
      throw new Error(`${file}: models.variants must map provider/model names to an effort, e.g. {"opencode-go/deepseek-v4.1-flash": "high"}`);
    }
  }
  if (escalation_skip_at !== undefined && (typeof escalation_skip_at !== "number" || !(escalation_skip_at > 0 && escalation_skip_at <= 1))) {
    throw new Error(`${file}: escalation_skip_at must be a number above 0 and at most 1`);
  }
  if (hard_tasks !== undefined && !HARD_TASKS.includes(hard_tasks as HardTasks)) throw new Error(`${file}: hard_tasks must be one of ${HARD_TASKS.join(", ")}`);
  if (takeover !== undefined && !TAKE_OVER.includes(takeover as TakeOver)) throw new Error(`${file}: takeover must be one of ${TAKE_OVER.join(", ")}`);
  if (guard_lines !== undefined && (typeof guard_lines !== "number" || !Number.isInteger(guard_lines) || guard_lines <= 0)) {
    throw new Error(`${file}: guard_lines must be a positive whole number`);
  }
  if (test_cmd !== undefined && (typeof test_cmd !== "string" || !test_cmd.trim())) throw new Error(`${file}: test_cmd must be a non-empty string`);
  // null is E4's written default: test_cmd
  if (integration_cmd != null && (typeof integration_cmd !== "string" || !integration_cmd.trim())) throw new Error(`${file}: integration_cmd must be a non-empty string`);
  let dirs: string[] | undefined;
  if (link_dirs !== undefined) {
    if (!Array.isArray(link_dirs) || link_dirs.some((d) => typeof d !== "string" || !d.trim())) throw new Error(`${file}: link_dirs must be a list of directory paths`);
    dirs = (link_dirs as string[]).map((dir) => {
      const parts = dir.split(/[\\/]+/).filter(Boolean);
      if (isAbsolute(dir) || parts.includes("..")) throw new Error(`${file}: link_dirs entry "${dir}" must be a path inside the repository`);
      if (BUILD_OUTPUT.test(parts.at(-1)!)) throw new Error(`${file}: link_dirs entry "${dir}" is build output, which is never linked`);
      return parts.join("/");
    });
  }
  return {
    ...(test_cmd !== undefined && { test_cmd }),
    ...(integration_cmd != null && { integration_cmd }),
    ...(dirs && { link_dirs: dirs }),
    ...(allow_commands !== undefined && { allow_commands: (allow_commands as string[]).map((c) => c.trim()) }),
    limits: caps,
    retention: keep,
    ...(models !== undefined && { models: roles as ModelsConfig }),
    ...(preset !== undefined && { preset: preset as Preset }),
    ...(escalation_skip_at !== undefined && { escalation_skip_at }),
    ...(guard_lines !== undefined && { guard_lines }),
    ...(hard_tasks !== undefined && { hard_tasks: hard_tasks as HardTasks }),
    ...(takeover !== undefined && { takeover: takeover as TakeOver }),
  };
}
