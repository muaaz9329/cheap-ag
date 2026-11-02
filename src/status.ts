import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, presetHere, readConsent, routeMoved } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { blockedFor, records } from "./jobs.js";
import { isAlive } from "./platform.js";
import { renderJob } from "./report.js";
import { spendWindows } from "./routing.js";
import { projectRoot } from "./workspace.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const RECENT = 5;

/**
 * `cheapag status` (spec story 112): provider, this repo's consent, running jobs, recent results, and tracked spend
 * against Go's windows. Read-only and non-interactive, so the plugin's `/cheapag:status` can wrap it.
 */
export function status(args: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  if (args.length) {
    out("✗ usage: cheapag status");
    return 1;
  }
  const provider = detectProvider()?.provider;
  out(`cheapag ${version} provider=${provider ? `${provider} preset=${presetHere(provider)}` : `none (run ${LOGIN_COMMAND})`}`);

  let root: string | undefined;
  try {
    root = projectRoot(process.cwd());
  } catch {
    out("repo: not a git repository (no jobs or consent here)");
  }
  if (root) {
    const consent = readConsent(root);
    out(`consent: ${!consent ? "not given; run /cheapag:allow"
      : consent.provider !== provider ? `given for ${providerLabel(consent.provider)}, not the current provider; run /cheapag:allow`
      : routeMoved(root, consent) ? "given for other worker models (preset or models changed); run /cheapag:allow"
      : `${describe(consent)} (since ${consent.approvedAt.slice(0, 10)})`}`);
    const all = records(root).sort((a, b) => String(b.timing?.startedAt ?? "").localeCompare(String(a.timing?.startedAt ?? "")));
    const inFlight = (r: (typeof all)[number]) => r.status === "RUNNING" || r.status === "BLOCKED";
    const live = all.filter((r) => inFlight(r) && !!r.pid && isAlive(r.pid));
    const rest = all.filter((r) => !live.includes(r));
    const headline = (r: (typeof all)[number]) =>
      `  ${renderJob(r).split("\n")[0]}${blockedFor(r)}${inFlight(r) && !live.includes(r) ? " (its server is gone; cancelled at next start)" : ""}`;
    out(live.length ? "running:" : "running: none");
    live.forEach((r) => out(headline(r)));
    out(rest.length ? "recent:" : "recent: none");
    rest.slice(0, RECENT).forEach((r) => out(headline(r)));
    if (rest.length > RECENT) out(`  … +${rest.length - RECENT} older (jobs list)`);
    const last = lastSession(root);
    if (last) {
      out(`claude prefix: ${(last.prefix / 1000).toFixed(1)}k tokens on the first turn of the last session here (${last.at.slice(0, 10)}); see "What it costs to keep in context" in the plugin README`);
      out(`claude cache: ${last.requests} requests, ${Math.round(last.hitRate * 100)}% of input from cache${last.ttl ? `, ${last.ttl} TTL` : ""}`);
    }
  }

  const spend = spendWindows();
  out(spend.length ? "spend (tracked on this machine, all repos; Go windows where capped):" : "spend: none tracked in the last 30 days");
  for (const { model, windows } of spend) {
    out(`  ${model}  ${windows.map((w) => `${w.window} $${w.spent.toFixed(2)}${w.capUsd ? `/$${w.capUsd.toFixed(2)} (${Math.round((w.spent / w.capUsd) * 100)}%)` : ""}`).join("  ")}`);
  }
  return 0;
}

/**
 * This repo's most recent Claude Code session, from its transcript: the context sent on the first turn (its fixed prefix:
 * system prompt, tools, skills, CLAUDE.md), how much of all input came from the prompt cache, and the cache TTL used.
 * Undefined when no transcript is readable.
 */
export function lastSession(root: string): { prefix: number; at: string; requests: number; hitRate: number; ttl?: "5m" | "1h" | "5m+1h" } | undefined {
  type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } };
  try {
    const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!existsSync(dir)) return undefined;
    const newest = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!newest) return undefined;
    // one entry per API response: a streamed response is written as several lines sharing its message id
    const byMessage = new Map<string, Usage>();
    for (const line of readFileSync(newest, "utf8").split("\n")) {
      if (!line) continue;
      const message = (JSON.parse(line) as { message?: { id?: string; usage?: Usage } }).message;
      if (message?.usage) byMessage.set(message.id ?? String(byMessage.size), message.usage);
    }
    const usages = [...byMessage.values()];
    if (!usages.length) return undefined;
    const input = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const total = usages.reduce((n, u) => n + input(u), 0);
    const m5 = usages.some((u) => u.cache_creation?.ephemeral_5m_input_tokens), h1 = usages.some((u) => u.cache_creation?.ephemeral_1h_input_tokens);
    return {
      prefix: input(usages[0]), at: statSync(newest).mtime.toISOString(), requests: usages.length,
      hitRate: total ? usages.reduce((n, u) => n + (u.cache_read_input_tokens ?? 0), 0) / total : 0,
      ttl: m5 && h1 ? "5m+1h" : m5 ? "5m" : h1 ? "1h" : undefined,
    };
  } catch {
    // an unreadable or half-written transcript: say nothing rather than guess
  }
  return undefined;
}
