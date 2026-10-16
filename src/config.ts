import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Optional settings: the repo's `cheapag.json` overrides the user's `~/.config/cheapag/config.json` (spec E4). */
export type Config = { test_cmd?: string; link_dirs: string[]; allow_commands: string[]; limits: Limits; retention: Retention };
/** Per-job caps, counted across the whole job: first run, self-fixes and escalation (spec: Models and limits). */
export type Limits = { max_turns: number; max_minutes: number; max_cost_usd: number };
/** How long cleanup keeps an unlanded worktree and a job folder, in days (spec A20). */
export type Retention = { unlanded_worktree_days: number; job_log_days: number };

const DEFAULTS: Config = {
  link_dirs: ["node_modules", ".venv", "venv", "vendor"], allow_commands: ["npx tsc --noEmit"],
  limits: { max_turns: 40, max_minutes: 20, max_cost_usd: 0.5 },
  retention: { unlanded_worktree_days: 7, job_log_days: 30 },
};
// build output is never linked: a job must build its own (ADR-0003)
const BUILD_OUTPUT = /^(dist|build|out|\.next|\.nuxt|target|coverage)$/;

export function loadConfig(root: string): Config {
  const user = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cheapag", "config.json");
  const [mine, repo] = [read(user), read(join(root, "cheapag.json"))];
  // caps merge key by key, so a repo can set one and keep the user's others
  return {
    ...DEFAULTS, ...mine, ...repo,
    limits: { ...DEFAULTS.limits, ...mine.limits, ...repo.limits },
    retention: { ...DEFAULTS.retention, ...mine.retention, ...repo.retention },
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
  const { test_cmd, link_dirs, allow_commands, limits, retention } = value as Record<string, unknown>;
  if (limits !== undefined && (typeof limits !== "object" || limits === null || Array.isArray(limits))) throw new Error(`${file}: limits must be an object`);
  const caps: Partial<Limits> = {};
  // E4's other limits keys (self_fix_attempts, max_parallel) are not read yet
  for (const key of ["max_turns", "max_minutes", "max_cost_usd"] as const) {
    const v = (limits as Record<string, unknown> | undefined)?.[key];
    if (v === undefined) continue;
    const whole = key === "max_turns";
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (whole && !Number.isInteger(v))) {
      throw new Error(`${file}: limits.${key} must be a positive ${whole ? "whole number" : "number"}`);
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
  if (test_cmd !== undefined && (typeof test_cmd !== "string" || !test_cmd.trim())) throw new Error(`${file}: test_cmd must be a non-empty string`);
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
    ...(dirs && { link_dirs: dirs }),
    ...(allow_commands !== undefined && { allow_commands: (allow_commands as string[]).map((c) => c.trim()) }),
    limits: caps,
    retention: keep,
  };
}
