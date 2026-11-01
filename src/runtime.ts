import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Selected by the executable, never by an inherited host-selection variable.
export let codex = false;
export let appName = "cheapag";
export let stateDir = ".cheapag";
export let configName = "cheapag.json";
export let allowCommand = "/cheapag:allow";

/** Run before importing any worker modules, including ones that cache XDG paths. */
export function configureCodex() {
  const home = process.env.CHEAPCODE_HOME || join(homedir(), ".cheapcode");
  if (!isAbsolute(home)) throw new Error("CHEAPCODE_HOME must be an absolute path");
  codex = true;
  appName = "cheapcode";
  stateDir = ".cheapcode";
  configName = "cheapcode.json";
  allowCommand = "cheapcode allow";
  for (const [key, dir] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", TMPDIR: "tmp", TEMP: "tmp", TMP: "tmp" })) {
    process.env[key] = join(home, dir);
  }
  mkdirSync(join(home, "tmp"), { recursive: true });
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase(); // Windows environment names are case-insensitive.
    if (name.startsWith("OPENCODE_") || name.startsWith("CHEAPAG_") || ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "CLAUDE_CODE_GIT_BASH_PATH"].includes(name)) delete process.env[key];
  }
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
}

/** Preserve the existing test hooks without inheriting the Claude edition's values. */
export const runtimeEnv = (suffix: string) => process.env[`${codex ? "CHEAPCODE" : "CHEAPAG"}_${suffix}`];
