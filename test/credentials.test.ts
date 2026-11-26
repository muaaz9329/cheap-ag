import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  detectProvider,
  localConfigured,
  LOGIN_COMMAND,
  NO_PROVIDER,
  ollamaConfigured,
  PROVIDERS,
  providerLabel,
  redact,
  savedProviders,
  usableProviders,
} from "../src/credentials.js";
import { hermeticHome, homeEnv } from "./harness.js";

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

const LOCAL = { base_url: "http://127.0.0.1:8084/v1", model: "test-model" };
const OLLAMA = { endpoint: "local", model: "test-model" };

/**
 * A temporary home holding `logins` and, when given, a user config; this process's XDG paths point at it and no
 * Ollama key is set, so a developer's own setup never changes a result.
 */
function useHome(logins: Record<string, string> = {}, config?: object) {
  const { home } = hermeticHome(logins);
  for (const [key, value] of Object.entries(homeEnv(home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  vi.stubEnv("OLLAMA_API_KEY", undefined);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  if (config) writeUserConfig(home, JSON.stringify(config));
  return home;
}

function writeUserConfig(home: string, text: string) {
  mkdirSync(join(home, "config", "cheapag"), { recursive: true });
  writeFileSync(join(home, "config", "cheapag", "config.json"), text);
}

test("the provider ids, labels and the no-provider texts users see", () => {
  expect(PROVIDERS).toEqual([
    { id: "opencode-go", label: "OpenCode Go" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" },
    { id: "ollama", label: "Ollama" },
    { id: "commandcode", label: "Command Code" },
    { id: "opencode", label: "OpenCode Zen" },
    { id: "local", label: "Custom endpoint" },
  ]);
  expect(PROVIDERS.map((provider) => providerLabel(provider.id))).toEqual([
    "OpenCode Go",
    "OpenRouter",
    "DeepSeek",
    "Ollama",
    "Command Code",
    "OpenCode Zen",
    "Custom endpoint",
  ]);
  expect(LOGIN_COMMAND).toBe("npx cheap-agent login");
  expect(NO_PROVIDER).toBe("FAIL reason: no worker provider; run npx cheap-agent login");
});

test("savedProviders: no auth file is no login; logins for the config-based providers are ignored", () => {
  useHome();
  expect(savedProviders()).toEqual([]);

  useHome({
    local: "fake-key-local",
    opencode: "fake-key-zen",
    ollama: "fake-key-ollama",
    commandcode: "fake-key-command",
    deepseek: "fake-key-deepseek",
    openrouter: "fake-key-openrouter",
    "opencode-go": "fake-key-go",
  });
  expect(savedProviders()).toEqual([
    "opencode-go",
    "openrouter",
    "deepseek",
    "commandcode",
    "opencode",
  ]);
});

test("savedProviders: an auth file that parses to null throws a TypeError (current behavior)", () => {
  const home = useHome({ deepseek: "fake-key-deepseek" });
  writeFileSync(join(home, "data", "opencode", "auth.json"), "null");
  expect(() => savedProviders()).toThrow(TypeError);
});

test("savedProviders: without XDG_DATA_HOME, or with it empty, the auth file is under ~/.local/share", () => {
  const home = useHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const auth = { deepseek: { type: "api", key: "fake-key-deepseek" } };
  writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify(auth));
  vi.stubEnv("XDG_DATA_HOME", "");
  expect(savedProviders()).toEqual(["deepseek"]);
  vi.stubEnv("XDG_DATA_HOME", undefined);
  expect(savedProviders()).toEqual(["deepseek"]);
});

test("localConfigured and ollamaConfigured: set up by the user config; none, damaged or unreadable counts as not set up", () => {
  const home = useHome();
  expect(localConfigured()).toBe(false);
  expect(ollamaConfigured()).toBe(false);

  writeUserConfig(home, JSON.stringify({ local: LOCAL, ollama: OLLAMA }));
  expect(localConfigured()).toBe(true);
  expect(ollamaConfigured()).toBe(true);

  writeUserConfig(home, JSON.stringify({ local: { model: "m" }, ollama: { endpoint: "nowhere" } }));
  expect(localConfigured()).toBe(false);
  expect(ollamaConfigured()).toBe(false);

  writeUserConfig(home, "{ not json");
  expect(localConfigured()).toBe(false);
  expect(ollamaConfigured()).toBe(false);

  // the key alone is an implicit Ollama Cloud opt-in, once the config can be read
  writeUserConfig(home, "{}");
  vi.stubEnv("OLLAMA_API_KEY", "fake-ollama-key");
  expect(ollamaConfigured()).toBe(true);
  expect(localConfigured()).toBe(false);
});

test("usableProviders: saved logins plus the set-up config-based providers, in detection order", () => {
  useHome({ commandcode: "fake-key-command", openrouter: "fake-key-openrouter" });
  expect(usableProviders()).toEqual(["openrouter", "commandcode"]);

  useHome({ local: "fake-key-local", ollama: "fake-key-ollama" });
  expect(usableProviders()).toEqual([]);

  useHome(
    { opencode: "fake-key-zen", "opencode-go": "fake-key-go" },
    { local: LOCAL, ollama: OLLAMA },
  );
  expect(usableProviders()).toEqual(["opencode-go", "ollama", "opencode", "local"]);

  useHome({ deepseek: "fake-key-deepseek" }, { local: LOCAL });
  expect(usableProviders()).toEqual(["deepseek", "local"]);
});

test("detectProvider: the chosen provider while set up, else Ollama, else the custom endpoint, else the first saved login", () => {
  useHome();
  expect(detectProvider()).toBeUndefined();

  const logins = { deepseek: "fake-key-deepseek", openrouter: "fake-key-openrouter" };
  useHome(logins);
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });

  useHome(logins, { local: LOCAL, ollama: OLLAMA });
  expect(detectProvider()).toEqual({ provider: "ollama", via: "config" });

  useHome(logins, { local: LOCAL, ollama: OLLAMA, provider: "local" });
  expect(detectProvider()).toEqual({ provider: "local", via: "config" });

  useHome(logins, { local: LOCAL, ollama: OLLAMA, provider: "deepseek" });
  expect(detectProvider()).toEqual({ provider: "deepseek", via: "login" });

  // a chosen provider that is not set up, or not a provider at all, is passed over
  useHome({ openrouter: "fake-key-openrouter" }, { provider: "deepseek" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });

  useHome({ openrouter: "fake-key-openrouter" }, { provider: "no-such-provider" });
  expect(detectProvider()).toEqual({ provider: "openrouter", via: "login" });

  useHome(logins, { local: LOCAL, provider: "ollama" });
  expect(detectProvider()).toEqual({ provider: "local", via: "config" });
});

test("redact: replaces key-shaped strings of 16 or more characters after the prefix", () => {
  expect(redact("key sk-or-v1-fake0123456789abcdef end")).toBe("key [redacted] end");
  expect(redact("a ci_live_fake0123456789ab, b sk-fake0123456789ab")).toBe(
    "a [redacted], b [redacted]",
  );
  expect(redact("short sk-fake0123456789a and xsk-fake0123456789abcdef")).toBe(
    "short sk-fake0123456789a and xsk-fake0123456789abcdef",
  );
});
