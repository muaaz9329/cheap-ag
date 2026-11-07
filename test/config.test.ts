import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { hermeticHome, homeEnv, tempRepo } from "./harness.js";

/** Config validation for keys that only the user config may set. */

function setup(user: object, repoConfig?: object) {
  const h = hermeticHome({});
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(user));
  for (const [key, value] of Object.entries(homeEnv(h.home))) if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  const repo = tempRepo();
  onTestFinished(() => { vi.unstubAllEnvs(); repo.cleanup(); });
  if (repoConfig) writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(repoConfig));
  return { dir: repo.dir, file };
}

test("preset: a user config preset loads, an unknown one names the allowed values, a repo cannot set it", () => {
  expect(loadConfig(setup({ preset: "balanced" }).dir).preset).toBe("balanced");
  expect(() => loadConfig(setup({ preset: "fast" }).dir)).toThrow("preset must be one of cheapest, balanced, strongest");
  expect(() => loadConfig(setup({}, { preset: "balanced" }).dir)).toThrow(/preset can only be set in .*config\.json/);
});
