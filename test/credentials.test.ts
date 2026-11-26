import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { savedProviders } from "../src/credentials.js";
import { hermeticHome } from "./harness.js";

test("savedProviders: the saved logins in detection order; an unreadable auth file is the same as no login", () => {
  const { home } = hermeticHome({ openrouter: "o", "opencode-go": "g", unknown: "x" });
  vi.stubEnv("XDG_DATA_HOME", join(home, "data"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  expect(savedProviders()).toEqual(["opencode-go", "openrouter"]);
  writeFileSync(join(home, "data", "opencode", "auth.json"), "{ not json");
  expect(savedProviders()).toEqual([]);
});
