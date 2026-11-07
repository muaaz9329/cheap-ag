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
/** Who finishes a step the worker could not (ticket 30): a Sonnet subagent, or Claude itself within limits.takeover_calls. */
export const TAKE_OVER = ["sonnet", "self"] as const;
export type TakeOver = (typeof TAKE_OVER)[number];
/** Per-job caps, counted across the whole job: first run, self-fixes and escalation (spec: Models and limits); `max_parallel` bounds a batch's concurrent groups; `max_blocked_minutes` bounds a wait for `reply`. */
export type Limits = { max_turns: number; max_minutes: number; max_cost_usd: number; max_parallel: number; max_blocked_minutes: number; repro_by_turns: number; takeover_calls: number };
/** How long cleanup keeps an unlanded worktree and a job folder, in days (spec A20). */
export type Retention = { unlanded_worktree_days: number; job_log_days: number };

const DEFAULTS: Config = {
  link_dirs: ["node_modules", ".venv", "venv", "vendor"], allow_commands: ["npx tsc --noEmit"],
  limits: { max_turns: 25, max_minutes: 20, max_cost_usd: 0.5, max_parallel: 3, max_blocked_minutes: 60, repro_by_turns: 20, takeover_calls: 15 },
  retention: { unlanded_worktree_days: 2, job_log_days: 7 },
  models: {}, // the provider's role defaults (src/routing.ts)
  escalation_skip_at: 0.8,
  guard_lines: 20,
  hard_tasks: "delegate",
  takeover: "sonnet",
};
// build output is never linked: a job must build its own (ADR-0003)
const BUILD_OUTPUT = /^(dist|build|out|\.next|\.nuxt|target|coverage)$/;

/** The user-level config every repo's `cheapag.json` overrides; `cheapag login` writes its `preset`. */
export const userConfigFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cheapag", "config.json");

/**
 * A local OpenAI-compatible server for the worker (llama.cpp, Strata, Ollama, LM Studio, vLLM, LiteLLM): `local` in the
 * user config only, so a repo's cheapag.json can never point the worker at another endpoint. `model` is the server's
 * model id; `api_key_file` names a file OpenCode reads the key from (Cheap Agent never reads it); `context` and `output`
 * are the model's token limits, which OpenCode needs to compact a long session before the server rejects it.
 */
export type LocalServer = { base_url: string; model: string; api_key_file?: string; context?: number; output?: number };

/** The user config's `local` server, undefined when none is set; throws on a damaged one. */
export function localServer(): LocalServer | undefined {
  const file = userConfigFile();
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as { local?: unknown };
  return value?.local === undefined ? undefined : parseLocal(value.local, file);
}

function parseLocal(local: unknown, file: string): LocalServer {
  if (typeof local !== "object" || local === null || Array.isArray(local)) throw new Error(`${file}: local must be an object`);
  const { base_url, model, api_key_file, context, output } = local as Record<string, unknown>;
  if (typeof base_url !== "string" || !/^https?:\/\/\S+$/.test(base_url)) throw new Error(`${file}: local.base_url must be an http(s) URL, e.g. http://127.0.0.1:8080/v1`);
  if (typeof model !== "string" || !model.trim()) throw new Error(`${file}: local.model must be the server's model id`);
  if (api_key_file !== undefined && (typeof api_key_file !== "string" || !isAbsolute(api_key_file))) throw new Error(`${file}: local.api_key_file must be an absolute path`);
  for (const [key, v] of [["context", context], ["output", output]] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v <= 0)) throw new Error(`${file}: local.${key} must be a positive whole number of tokens`);
  }
  return {
    base_url: base_url.replace(/\/+$/, ""), model: model.trim(),
    ...(api_key_file !== undefined && { api_key_file }), ...(context !== undefined && { context: context as number }), ...(output !== undefined && { output: output as number }),
  };
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
  const { test_cmd, integration_cmd, link_dirs, allow_commands, limits, retention, models, escalation_skip_at, guard_lines, hard_tasks, takeover, local, preset } = value as Record<string, unknown>;
  if (local !== undefined) {
    if (file !== userConfigFile()) throw new Error(`${file}: local can only be set in ${userConfigFile()}, never in a repo`);
    parseLocal(local, file);
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
