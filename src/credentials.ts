import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chosenProvider, localServer } from "./config.js";

/**
 * Credentials come only from saved logins in OpenCode's store, written by `cheapag login` (ADR-0004). The local
 * server needs none: it counts as set up once the user config names it, and OpenCode reads its key file, if any.
 */

/** Providers in detection order; `label` is what `cheapag login` shows. */
export const PROVIDERS = [
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "commandcode", label: "Command Code" },
  { id: "local", label: "Custom endpoint" },
  { id: "opencode", label: "OpenCode Zen" },
] as const;

export type Provider = { provider: (typeof PROVIDERS)[number]["id"]; via: "login" | "config" };

export const LOGIN_COMMAND = "npx cheap-agent login";
export const NO_PROVIDER = `FAIL reason: no worker provider; run ${LOGIN_COMMAND}`;

/** OpenCode keeps logins for every installed copy in one shared file. */
function authFile() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");
}

/** Supported providers with a saved login, in detection order. Only the provider ids are used; keys are never kept or passed on. */
export function savedProviders(): Provider["provider"][] {
  let saved: Record<string, unknown>;
  try {
    saved = existsSync(authFile()) ? JSON.parse(readFileSync(authFile(), "utf8")) : {};
  } catch {
    return []; // an unreadable auth file is the same as no login
  }
  return PROVIDERS.map((p) => p.id).filter((id) => id in saved && id !== "local");
}

/** Whether the user config names a usable local server; a damaged one counts as none here, loadConfig reports it. */
export function localConfigured() {
  try {
    return !!localServer();
  } catch {
    return false;
  }
}

export const providerLabel = (id: Provider["provider"]) => PROVIDERS.find((p) => p.id === id)!.label;

/** Supported providers ready to use: saved logins, plus the custom endpoint when the user config names one; in detection order. */
export function usableProviders(): Provider["provider"][] {
  const saved = savedProviders();
  return PROVIDERS.map((p) => p.id).filter((id) => (id === "local" ? localConfigured() : saved.includes(id)));
}

/**
 * The provider the worker uses: the one `cheapag provider` picked, while it is still set up; else a configured custom
 * endpoint (set up on purpose, so it wins), else the first saved login.
 */
export function detectProvider(): Provider | undefined {
  const chosen = PROVIDERS.find((p) => p.id === chosenProvider())?.id;
  if (chosen && usableProviders().includes(chosen)) return { provider: chosen, via: chosen === "local" ? "config" : "login" };
  if (localConfigured()) return { provider: "local", via: "config" };
  const [first] = savedProviders();
  return first && { provider: first, via: "login" };
}

/** Strips key-shaped strings (OpenRouter's sk-or-v1-…, DeepSeek/OpenAI-style sk-…, Cheaper Inference's ci_live_…) from anything that leaves the process. */
export function redact(text: string) {
  return text.replace(/\b(?:sk-|ci_live_)[A-Za-z0-9_-]{16,}/g, "[redacted]");
}
