import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, modelWarnings, presetHere, readConsent, routeMoved } from "./consent.js";
import {
  detectProvider,
  LOGIN_COMMAND,
  providerLabel,
  redact,
  type Provider,
} from "./credentials.js";
import { blockedFor, newestFirst } from "./jobs.js";
import { isAlive } from "./platform.js";
import { renderJob } from "./report.js";
import { spendWindows } from "./routing.js";
import { projectRoot } from "./workspace.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const RECENT = 5;

type ProviderId = Provider["provider"];
type Job = ReturnType<typeof newestFirst>[number];

/**
 * `cheapag status` (spec story 112): provider, this repo's consent, running jobs, recent results, and tracked spend
 * against Go's windows. Read-only and non-interactive, so the plugin's `/cheapag:status` can wrap it.
 */
export function status(args: string[]): number {
  if (args.length) {
    print("✗ usage: cheapag status");
    return 1;
  }
  const provider = detectProvider()?.provider;
  print(`cheapag ${version} provider=${providerText(provider)}`);

  let root: string | undefined;
  try {
    root = projectRoot(process.cwd());
  } catch {
    print("repo: not a git repository (no jobs or consent here)");
  }
  if (root) {
    print(`consent: ${consentText(root, provider)}`);
    print(storageLine(root));
    printJobs(root);
    printLastSession(root);
  }

  // a `models` entry naming another provider is ignored when a job routes: say which model actually runs
  if (provider) for (const warning of modelWarnings(provider, root)) print(`! ${warning}`);

  const spend = spendWindows();
  print(
    spend.length
      ? "spend (tracked on this machine, all repos; Go windows where capped):"
      : "spend: none tracked in the last 30 days",
  );
  for (const { model, windows } of spend) {
    print(
      `  ${model}  ${windows.map((w) => `${w.window} $${w.spent.toFixed(2)}${w.capUsd ? `/$${w.capUsd.toFixed(2)} (${Math.round((w.spent / w.capUsd) * 100)}%)` : ""}`).join("  ")}`,
    );
  }
  return 0;
}

/** The `provider=` value: the provider and its preset, or how to log in when there is none. */
function providerText(provider: ProviderId | undefined): string {
  if (!provider) return `none (run ${LOGIN_COMMAND})`;
  return `${provider} preset=${presetHere(provider)}`;
}

/** The `consent:` value: whether this repo's consent covers the current provider and its models. */
function consentText(root: string, provider: ProviderId | undefined): string {
  const consent = readConsent(root);
  if (!consent) return "not given; run /cheapag:allow";
  if (consent.provider !== provider) {
    const label = providerLabel(consent.provider);
    return `given for ${label}, not the current provider; run /cheapag:allow`;
  }
  if (routeMoved(root, consent)) {
    return "given for other worker models (preset or models changed); run /cheapag:allow";
  }
  // approvedAt is read last, so a hand-edited record without it still reports the cases above
  return `${describe(consent)} (since ${consent.approvedAt.slice(0, 10)})`;
}

/** The `running:` jobs whose server is alive, then the newest `recent:` others. */
function printJobs(root: string) {
  const all = newestFirst(root);
  const live = all.filter((job) => isInFlight(job) && !!job.pid && isAlive(job.pid));
  const rest = all.filter((job) => !live.includes(job));
  const headline = (job: Job) => jobHeadline(job, live.includes(job));
  print(live.length ? "running:" : "running: none");
  live.forEach((job) => print(headline(job)));
  print(rest.length ? "recent:" : "recent: none");
  rest.slice(0, RECENT).forEach((job) => print(headline(job)));
  if (rest.length > RECENT) print(`  … +${rest.length - RECENT} older (jobs list)`);
}

function isInFlight(job: Job): boolean {
  return job.status === "RUNNING" || job.status === "BLOCKED";
}

const SERVER_GONE = " (its server is gone; cancelled at next start)";

/** A job's one-line headline, marked when it is still in flight but its server is not alive. */
function jobHeadline(job: Job, live: boolean): string {
  const firstLine = renderJob(job).split("\n")[0];
  const waiting = blockedFor(job);
  const gone = isInFlight(job) && !live ? SERVER_GONE : "";
  return `  ${firstLine}${waiting}${gone}`;
}

/** The `claude prefix:` and `claude cache:` lines of this repo's last Claude Code session, when there is one. */
function printLastSession(root: string) {
  const last = lastSession(root);
  if (!last) return;
  const thousands = (last.prefix / 1000).toFixed(1);
  const day = last.at.slice(0, 10);
  print(
    `claude prefix: ${thousands}k tokens on the first turn of the last session here (${day}); see "What it costs to keep in context" in the plugin README`,
  );
  const percent = Math.round(last.hitRate * 100);
  const ttl = last.ttl ? `, ${last.ttl} TTL` : "";
  print(`claude cache: ${last.requests} requests, ${percent}% of input from cache${ttl}`);
}

/** Writes one line of the report, with any API key in it redacted. */
function print(line: string) {
  process.stdout.write(redact(line) + "\n");
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** `storage: <size> in .cheapag (n job folders, m worktrees)`, plus the clean hint once the folder passes 1GB. */
function storageLine(root: string): string {
  const state = join(root, ".cheapag");
  const jobs = join(state, "jobs");
  const trees = join(state, "worktrees");
  let bytes = 0;
  const walk = (path: string) => {
    let info;
    try {
      info = lstatSync(path);
    } catch {
      return;
    }
    // never follow symlinks: a worktree links dependency dirs, which are not its own storage
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      bytes += info.size;
      return;
    }
    if (!info.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) walk(join(path, name));
  };
  walk(jobs);
  walk(trees);
  const folders = (dir: string) => {
    try {
      return readdirSync(dir).filter((name) => {
        try {
          return lstatSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      }).length;
    } catch {
      return 0;
    }
  };
  const size =
    bytes >= GB
      ? `${(bytes / GB).toFixed(1)} GB`
      : bytes >= MB
        ? `${(bytes / MB).toFixed(1)} MB`
        : `${(bytes / KB).toFixed(1)} KB`;
  return `storage: ${size} in .cheapag (${folders(jobs)} job folders, ${folders(trees)} worktrees)${bytes > GB ? " · run: npx cheap-agent clean" : ""}`;
}

/**
 * This repo's most recent Claude Code session, from its transcript: the context sent on the first turn (its fixed prefix:
 * system prompt, tools, skills, CLAUDE.md), how much of all input came from the prompt cache, and the cache TTL used.
 * Undefined when no transcript is readable.
 */
export function lastSession(
  root: string,
):
  | { prefix: number; at: string; requests: number; hitRate: number; ttl?: "5m" | "1h" | "5m+1h" }
  | undefined {
  type Usage = {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  };
  try {
    const dir = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      "projects",
      root.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    if (!existsSync(dir)) return undefined;
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
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
    const input = (u: Usage) =>
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    const total = usages.reduce((n, u) => n + input(u), 0);
    const m5 = usages.some((u) => u.cache_creation?.ephemeral_5m_input_tokens),
      h1 = usages.some((u) => u.cache_creation?.ephemeral_1h_input_tokens);
    return {
      prefix: input(usages[0]),
      at: statSync(newest).mtime.toISOString(),
      requests: usages.length,
      hitRate: total ? usages.reduce((n, u) => n + (u.cache_read_input_tokens ?? 0), 0) / total : 0,
      ttl: m5 && h1 ? "5m+1h" : m5 ? "5m" : h1 ? "1h" : undefined,
    };
  } catch {
    // an unreadable or half-written transcript: say nothing rather than guess
  }
  return undefined;
}
