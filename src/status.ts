import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, readConsent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { blockedFor, records } from "./jobs.js";
import { isAlive, isSupported, UNSUPPORTED_REASON } from "./platform.js";
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
  if (!isSupported()) {
    out(`✗ ${UNSUPPORTED_REASON}`);
    return 1;
  }
  if (args.length) {
    out("✗ usage: cheapag status");
    return 1;
  }
  const provider = detectProvider()?.provider;
  out(`cheapag ${version} provider=${provider ?? `none (run ${LOGIN_COMMAND})`}`);

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
    const prefix = lastPrefix(root);
    if (prefix) out(`claude prefix: ${(prefix.tokens / 1000).toFixed(1)}k tokens on the first turn of the last session here (${prefix.at.slice(0, 10)}); see "What it costs to keep in context" in the plugin README`);
  }

  const spend = spendWindows();
  out(spend.length ? "spend (tracked on this machine, all repos; Go windows where capped):" : "spend: none tracked in the last 30 days");
  for (const { model, windows } of spend) {
    out(`  ${model}  ${windows.map((w) => `${w.window} $${w.spent.toFixed(2)}${w.capUsd ? `/$${w.capUsd.toFixed(2)} (${Math.round((w.spent / w.capUsd) * 100)}%)` : ""}`).join("  ")}`);
  }
  return 0;
}

/**
 * The context Claude Code sent on the first turn of this repo's most recent session (its fixed prefix: system prompt,
 * tools, skills, CLAUDE.md), read from the session transcript. Undefined when no transcript is readable.
 */
export function lastPrefix(root: string): { tokens: number; at: string } | undefined {
  try {
    const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!existsSync(dir)) return undefined;
    const newest = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!newest) return undefined;
    for (const line of readFileSync(newest, "utf8").split("\n")) {
      const usage = (JSON.parse(line || "{}") as { message?: { usage?: Record<string, number> } }).message?.usage;
      if (usage) return { tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), at: statSync(newest).mtime.toISOString() };
    }
  } catch {
    // an unreadable or half-written transcript: say nothing rather than guess
  }
  return undefined;
}
