import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = {
  provider: "opencode-go" | "openrouter" | "deepseek";
  via: "login" | "OPENCODE_GO_API_KEY" | "OPENROUTER_API_KEY" | "DEEPSEEK_API_KEY";
};

export const NO_PROVIDER =
  "FAIL reason: no worker provider; log in to OpenCode Go with `npx opencode-ai auth login` (pick OpenCode Go), " +
  "or set OPENCODE_GO_API_KEY, OPENROUTER_API_KEY or DEEPSEEK_API_KEY in the environment Claude Code starts cheapag with";

/** OpenCode keeps logins for every installed copy in one shared file. */
function authFile() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");
}

/** Order: existing OpenCode Go login, OPENCODE_GO_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY. Never reads key values. */
export function detectProvider(): Provider | undefined {
  try {
    if (existsSync(authFile()) && "opencode-go" in JSON.parse(readFileSync(authFile(), "utf8"))) {
      return { provider: "opencode-go", via: "login" };
    }
  } catch {
    // an unreadable auth file is the same as no login
  }
  if (process.env.OPENCODE_GO_API_KEY) return { provider: "opencode-go", via: "OPENCODE_GO_API_KEY" };
  if (process.env.OPENROUTER_API_KEY) return { provider: "openrouter", via: "OPENROUTER_API_KEY" };
  if (process.env.DEEPSEEK_API_KEY) return { provider: "deepseek", via: "DEEPSEEK_API_KEY" };
}

/** Strips known key values and key-shaped strings from anything that leaves the process. */
export function redact(text: string) {
  for (const name of ["OPENCODE_GO_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) {
    const value = process.env[name];
    if (value) text = text.split(value).join("[redacted]");
  }
  // covers OpenRouter's sk-or-v1-… as well as DeepSeek/OpenAI-style sk-…
  return text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
}
