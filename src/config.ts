import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Optional settings: the repo's `cheapag.json` overrides the user's `~/.config/cheapag/config.json` (spec E4). */
export type Config = { test_cmd?: string };

export function loadConfig(root: string): Config {
  const user = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cheapag", "config.json");
  return { ...read(user), ...read(join(root, "cheapag.json")) };
}

function read(file: string): Config {
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
  const { test_cmd } = value as Record<string, unknown>;
  if (test_cmd !== undefined && (typeof test_cmd !== "string" || !test_cmd.trim())) throw new Error(`${file}: test_cmd must be a non-empty string`);
  return { test_cmd };
}
