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
type SpendWindow = ReturnType<typeof spendWindows>[number]["windows"][number];

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

  printSpend();
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

/** Tracked spend per model over the last 30 days, against Go's caps where the model has them. */
function printSpend() {
  const spend = spendWindows();
  print(
    spend.length
      ? "spend (tracked on this machine, all repos; Go windows where capped):"
      : "spend: none tracked in the last 30 days",
  );
  for (const { model, windows } of spend) {
    print(`  ${model}  ${windows.map(spendWindowText).join("  ")}`);
  }
}

/** One window's spend, e.g. `5h $4.00/$16.00 (25%)`, or `5h $4.00` when the model has no cap. */
function spendWindowText(entry: SpendWindow): string {
  const spent = `${entry.window} $${entry.spent.toFixed(2)}`;
  if (!entry.capUsd) return spent;
  const percent = Math.round((entry.spent / entry.capUsd) * 100);
  return `${spent}/$${entry.capUsd.toFixed(2)} (${percent}%)`;
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
  const bytes = sizeOf(jobs) + sizeOf(trees);
  const size = formatSize(bytes);
  const counts = `${countFolders(jobs)} job folders, ${countFolders(trees)} worktrees`;
  const hint = bytes > GB ? " · run: npx cheap-agent clean" : "";
  return `storage: ${size} in .cheapag (${counts})${hint}`;
}

/** The bytes of every file under `path`; what cannot be read or entered counts as nothing, never an error. */
function sizeOf(path: string): number {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return 0;
  }
  // never follow symlinks: a worktree links dependency dirs, which are not its own storage
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  return names.reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

/** How many folders `parent` holds; a folder that cannot be listed or examined counts as none. */
function countFolders(parent: string): number {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return 0;
  }
  return names.filter((name) => isFolder(join(parent, name))).length;
}

function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `bytes` in KB, MB or GB, one decimal. */
function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / KB).toFixed(1)} KB`;
}

/** The token counts of one API response, as a Claude Code transcript records them. */
type Usage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

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
  // the whole read is guarded: a garbage line can throw in parsing as well as in reading
  try {
    const newest = newestTranscript(root);
    if (!newest) return undefined;
    const usages = readUsages(newest);
    if (!usages.length) return undefined;
    return {
      prefix: inputTokens(usages[0]),
      at: statSync(newest).mtime.toISOString(),
      requests: usages.length,
      hitRate: cacheHitRate(usages),
      ttl: cacheTtl(usages),
    };
  } catch {
    // an unreadable or half-written transcript: say nothing rather than guess
  }
  return undefined;
}

/** The most recently written transcript of `root`'s Claude Code sessions, if there is one. */
function newestTranscript(root: string): string | undefined {
  const folder = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
    root.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  if (!existsSync(folder)) return undefined;
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(folder, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

/** One usage per API response in the transcript, in the order each response first appears. */
function readUsages(transcript: string): Usage[] {
  // a streamed response is written as several lines sharing its message id
  const byMessage = new Map<string, Usage>();
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line) continue;
    const message = (JSON.parse(line) as { message?: { id?: string; usage?: Usage } }).message;
    if (message?.usage) byMessage.set(message.id ?? String(byMessage.size), message.usage);
  }
  return [...byMessage.values()];
}

/** All input of one response: uncached, read from the prompt cache, and written to it. */
function inputTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/** The share of all input that was read from the prompt cache; 0 when there was no input. */
function cacheHitRate(usages: Usage[]): number {
  const total = usages.reduce((sum, usage) => sum + inputTokens(usage), 0);
  if (!total) return 0;
  const cached = usages.reduce((sum, usage) => sum + (usage.cache_read_input_tokens ?? 0), 0);
  return cached / total;
}

/** The prompt cache TTLs the session wrote with. */
function cacheTtl(usages: Usage[]): "5m" | "1h" | "5m+1h" | undefined {
  const fiveMinutes = usages.some((usage) => usage.cache_creation?.ephemeral_5m_input_tokens);
  const oneHour = usages.some((usage) => usage.cache_creation?.ephemeral_1h_input_tokens);
  if (fiveMinutes && oneHour) return "5m+1h";
  if (fiveMinutes) return "5m";
  if (oneHour) return "1h";
  return undefined;
}
