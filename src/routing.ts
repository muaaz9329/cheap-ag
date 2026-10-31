import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { providerLabel, type Provider } from "./credentials.js";
import type { RunResult, Session } from "./worker.js";

/** Routing: which model each role runs, fallbacks on provider limits, escalation eligibility, and the local spend ledger. */

/** A model as OpenCode's session.create takes it, plus per-model OpenCode options written into the generated config. */
export type WorkerModel = { providerID: string; id: string; options?: Record<string, unknown> };
type ProviderId = Provider["provider"];

// verified on OpenCode 1.19.0: options.provider becomes OpenRouter's request-body routing preference, so upstreams that
// collect data are never used. Every OpenRouter model carries it.
const OPENROUTER_PRIVATE = { provider: { data_collection: "deny" } };

/**
 * Default models per provider and role (spec: Models and limits): each list is the role's model, then its fallbacks.
 * Go and DeepSeek ids are in OpenCode 1.19.0's bundled model catalog; OpenRouter's are on openrouter.ai/api/v1/models
 * (checked 2026-10-16). Direct DeepSeek has no other models to fall back to.
 */
export const ROLES: Record<ProviderId, { implement: string[]; research: string[]; escalation: string }> = {
  "opencode-go": {
    implement: ["deepseek-v4.1-flash", "qwen3.7-plus", "glm-5.3", "kimi-k3"],
    research: ["qwen3.8-flash", "deepseek-v4.1-flash"],
    escalation: "deepseek-v4-pro",
  },
  openrouter: {
    implement: ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.7-plus", "z-ai/glm-5.3", "moonshotai/kimi-k3"],
    research: ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash"],
    // GLM-5.3-Flash: 37% on Terminal-Bench 4.0 vs V4 Pro 14% (Vals, 2026-10-16), and cheaper ($0.05 in / $0.20 out)
    escalation: "z-ai/glm-5.3-flash",
  },
  deepseek: { implement: ["deepseek-flash"], research: ["deepseek-flash"], escalation: "deepseek-v4-pro" },
  // Command Code's Provider API (OpenAI-compatible); ids from api.commandcode.ai/provider/v1/models (checked 2026-10-31)
  commandcode: { implement: ["deepseek/deepseek-v4.1-flash"], research: ["deepseek/deepseek-v4.1-flash"], escalation: "deepseek/deepseek-v4-pro" },
};

/** `cheapag login`'s worker-model presets (ticket 27): a named `models` per provider; roles a preset leaves out keep the defaults above. */
export const PRESET_NAMES = ["cheapest", "balanced", "strongest"] as const;
export type Preset = (typeof PRESET_NAMES)[number];
// balanced is the default route, Flash for every tier: GLM-5.3 cost Claude 1.5x fewer tokens than Flash on the tasks Flash
// lost (ticket 25) but showed no gain on the hard tier (26), so it is opt-in as strongest. cheapest is balanced until a
// cheaper worker than Flash exists (a tie reports balanced). Kimi K3 was dropped: $0.36 worker per task, BUDGET on half.
export const PRESETS: Record<ProviderId, Record<Preset, ModelsConfig>> = {
  "opencode-go": {
    cheapest: { implement: "opencode-go/deepseek-v4.1-flash" },
    balanced: { implement: "opencode-go/deepseek-v4.1-flash" },
    strongest: { implement: "opencode-go/glm-5.3", medium: "opencode-go/glm-5.3" },
  },
  openrouter: {
    cheapest: { implement: "openrouter/deepseek/deepseek-v4.1-flash" },
    balanced: { implement: "openrouter/deepseek/deepseek-v4.1-flash" },
    strongest: { implement: "openrouter/z-ai/glm-5.3", medium: "openrouter/z-ai/glm-5.3" },
  },
  // direct DeepSeek has no GLM: strongest implements on V4 Pro
  deepseek: {
    cheapest: { implement: "deepseek/deepseek-flash" },
    balanced: { implement: "deepseek/deepseek-flash" },
    strongest: { implement: "deepseek/deepseek-v4-pro" },
  },
  // Command Code serves DeepSeek only here: strongest implements on V4 Pro
  commandcode: {
    cheapest: { implement: "commandcode/deepseek/deepseek-v4.1-flash" },
    balanced: { implement: "commandcode/deepseek/deepseek-v4.1-flash" },
    strongest: { implement: "commandcode/deepseek/deepseek-v4-pro" },
  },
};

/** The preset whose route `models` gives on this provider, else custom (`preset=` in ping and status); a tie names balanced, the default. */
export function presetOf(provider: ProviderId, models: ModelsConfig = {}): Preset | "custom" {
  const key = (m: ModelsConfig) => JSON.stringify(fullRoute(provider, m));
  return (["balanced", "cheapest", "strongest"] as const).find((p) => key(PRESETS[provider][p]) === key(models)) ?? "custom";
}

const model = (provider: ProviderId, id: string): WorkerModel =>
  provider === "openrouter" ? { providerID: provider, id, options: OPENROUTER_PRIVATE } : { providerID: provider, id };

/**
 * The models one job may run. `fallbacks` continue the session, in order, when the current model hits a provider limit;
 * the escalation model has none. Ticket 13's research uses `research` then `researchFallbacks`.
 */
export type Route = {
  implement: WorkerModel; fallbacks: WorkerModel[]; escalation?: WorkerModel; research?: WorkerModel; researchFallbacks: WorkerModel[];
  /** Ticket 26: the implement model for a `medium` or `hard` difficulty hint; absent = `implement`. */
  medium?: WorkerModel; hard?: WorkerModel;
};

/** Config (spec E4) `models`: full `provider/model` names; a role set for another provider than the one logged in is ignored. */
export type ModelsConfig = { implement?: string; medium?: string; hard?: string; research?: string; escalation?: string; fallback?: string[] };

/** Claude's rating of a task from the issue (ticket 26): easy < 15 min, medium < 1 h, hard > 1 h of an engineer new to the code. */
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** The model a job implements on: hard takes the hard model, else the medium one; medium the medium one; easy or no hint `implement`. */
export const tierModel = (r: Route, d?: Difficulty) => (d === "hard" ? r.hard ?? r.medium : d === "medium" ? r.medium : undefined) ?? r.implement;

/** Every model a provider's worker may run, defaults overridden by the config, before the repo's allowlist filters them. */
export function fullRoute(provider: ProviderId, models: ModelsConfig = {}): Route {
  const roles = ROLES[provider];
  const own = (name?: string) => (name?.startsWith(`${provider}/`) ? name.slice(provider.length + 1) : undefined);
  const ownFallbacks = models.fallback?.map(own).filter((id): id is string => !!id);
  const [research, ...researchFallbacks] = [own(models.research) ?? roles.research[0], ...roles.research.slice(1)];
  const tier = (name?: string) => (own(name) ? model(provider, own(name)!) : undefined);
  return {
    implement: model(provider, own(models.implement) ?? roles.implement[0]),
    medium: tier(models.medium),
    hard: tier(models.hard),
    fallbacks: (models.fallback ? ownFallbacks! : roles.implement.slice(1)).map((id) => model(provider, id)),
    escalation: model(provider, own(models.escalation) ?? roles.escalation),
    research: model(provider, research),
    researchFallbacks: researchFallbacks.map((id) => model(provider, id)),
  };
}

/** Every distinct model a route may send code to, first to last (for the config, the CONSENT block and `cheapag allow`). */
export const routeModels = (r: Route) => unique([r.implement, r.medium, r.hard, r.research, r.escalation, ...r.fallbacks, ...r.researchFallbacks]);

const unique = (ms: (WorkerModel | undefined)[]) => ms.filter((m, i): m is WorkerModel => !!m && ms.findIndex((o) => o && modelName(o) === modelName(m)) === i);

export const modelName = (m: WorkerModel) => `${m.providerID}/${m.id}`;

/** What one run hit instead of finishing: a provider limit (Go window, free tier, or a plain rate limit), from OpenCode's retry status. */
export type Limit = { model: string; reason?: string; message: string; next: number };

/** A role's model chain within one job: the model the session runs on now, the fallbacks left, and what was hit. */
export type Chain = { first: WorkerModel; current: WorkerModel; rest: WorkerModel[]; limits: Limit[]; used: string[] };
export const chain = (first: WorkerModel, fallbacks: WorkerModel[]): Chain => ({ first, current: first, rest: [...fallbacks], limits: [], used: [] });

const CONTINUE = "The previous model hit a usage limit and was stopped. Continue the current step from where it left off.";

/**
 * One prompt on the chain's current model. On a provider limit the worker has already aborted the session (never waiting
 * out the retry); the same session continues on the next fallback. `budget` is set when the job must stop as BUDGET:
 * every allowed model is limited, or (OpenRouter) the credit is gone, which no other model can help with.
 * With `escalation`, the prompt runs on that model alone: a limit there is returned (in `limit`), never fallen back from.
 */
export async function runRouted(session: Pick<Session, "run">, prompt: string, c: Chain, provider: ProviderId, escalation?: WorkerModel, interrupt?: AbortSignal): Promise<RunResult & { budget?: string }> {
  // the first model is the session's own; once moved, every prompt names the fallback explicitly
  let result = await session.run(prompt, escalation ?? (c.current === c.first ? undefined : c.current), interrupt);
  if (escalation && result.limit) c.limits.push(result.limit);
  while (result.limit && !escalation) {
    c.limits.push(result.limit);
    const next = c.rest.shift();
    if (!next) return { ...result, budget: exhausted(provider, c.limits) };
    c.current = next;
    c.used.push(modelName(next));
    result = await session.run(CONTINUE, next, interrupt);
  }
  if (provider === "openrouter" && result.httpStatus === 402) return { ...result, budget: "OpenRouter credits exhausted" };
  return result;
}

/** The BUDGET reason once every allowed model is limited, with the earliest reset the provider gave. */
function exhausted(provider: ProviderId, limits: Limit[]) {
  const ids = [...new Set(limits.map((l) => l.model.slice(l.model.indexOf("/") + 1)))].join(", ");
  // OpenCode's next retry honours the provider's retry-after, i.e. the reset; a next only seconds away is just its backoff
  // (no retry-after was sent), so then quote the provider's own text instead
  const next = Math.min(...limits.map((l) => l.next).filter((n) => Number.isFinite(n) && n > Date.now() + 60_000));
  const when = Number.isFinite(next) ? `~${clock(next)}` : limits.at(-1)!.message;
  const go = limits.find((l) => l.reason === "account_rate_limit" || l.reason === "free_tier_limit");
  if (go) {
    // OpenCode words it "<limitName> usage limit reached. It will reset in …"
    const window = go.reason === "free_tier_limit" ? "free tier" : go.message.match(/^(.+?) usage limit reached/i)?.[1].toLowerCase() ?? "usage";
    return `Go ${window} window exhausted for ${ids} (resets ${when})`;
  }
  return `${providerLabel(provider)} rate limit on every allowed model: ${ids} (retry ${when})`;
}

/** Local time as HH:MM, with the date in front when it is not today. */
export function clock(ms: number) {
  const d = new Date(ms);
  const hhmm = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? hhmm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hhmm}`;
}

// ---- spend ledger ----

/**
 * Go's monthly caps per model in USD (spec C4, the Go plan; models without a known cap are not tracked against one).
 * shortcut: Go Plus caps (4x) are not known to Cheap Agent; add a plan setting if Go Plus users report early skips.
 */
const GO_CAPS: Record<string, number> = {
  "opencode-go/deepseek-v4.1-flash": 80, "opencode-go/deepseek-v4-pro": 15, "opencode-go/qwen3.8-max": 15,
  "opencode-go/qwen3.8-flash": 30, "opencode-go/qwen3.7-plus": 60,
};
/** Go enforces 20% of the monthly cap per 5 h, 50% per week, 100% per month (spec C4); tracked here as rolling windows. */
const WINDOWS = [
  { name: "5h", ms: 5 * 3_600_000, share: 0.2 },
  { name: "weekly", ms: 7 * 86_400_000, share: 0.5 },
  { name: "monthly", ms: 30 * 86_400_000, share: 1 },
];

/**
 * The ledger is per user, not per repo: Go's windows are per account, so every repo's jobs draw on the same caps.
 * One JSON line per model per job: `{at, model, costUsd}`.
 * shortcut: never pruned (a line per job and model); trim entries older than the monthly window if it ever grows large.
 */
export const ledgerFile = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cheapag", "spend.jsonl");

export function recordSpend(spend: Record<string, number>) {
  const lines = Object.entries(spend).filter(([, cost]) => cost > 0).map(([m, costUsd]) => JSON.stringify({ at: new Date().toISOString(), model: m, costUsd }) + "\n");
  if (!lines.length) return;
  mkdirSync(dirname(ledgerFile()), { recursive: true });
  appendFileSync(ledgerFile(), lines.join(""));
}

/** A model's fullest tracked window: the share of its cap used (plus `extra` not yet recorded); undefined without a known cap. */
export function capUse(name: string, extra = 0): { used: number; window: string; capUsd: number } | undefined {
  const monthly = GO_CAPS[name];
  if (!monthly) return undefined;
  const now = Date.now();
  const entries = readLedger().filter((e) => e.model === name);
  return WINDOWS.map(({ name: window, ms, share }) => {
    const spent = extra + entries.filter((e) => now - e.at < ms).reduce((sum, e) => sum + e.costUsd, 0);
    return { used: spent / (monthly * share), window, capUsd: monthly * share };
  }).reduce((a, b) => (b.used > a.used ? b : a));
}

/** Tracked spend per model and window, with the window's cap where Go has one (for `cheapag status`); models unspent this month are left out. */
export function spendWindows(now = Date.now()) {
  const ledger = readLedger();
  return [...new Set(ledger.map((e) => e.model))].sort().flatMap((model) => {
    const windows = WINDOWS.map(({ name: window, ms, share }) => ({
      window,
      spent: ledger.filter((e) => e.model === model && now - e.at < ms).reduce((sum, e) => sum + e.costUsd, 0),
      capUsd: GO_CAPS[model] ? GO_CAPS[model] * share : undefined,
    }));
    return windows.at(-1)!.spent > 0 ? [{ model, windows }] : [];
  });
}

function readLedger(): { at: number; model: string; costUsd: number }[] {
  if (!existsSync(ledgerFile())) return [];
  return readFileSync(ledgerFile(), "utf8").split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line);
      return typeof e.model === "string" && typeof e.costUsd === "number" ? [{ model: e.model, costUsd: e.costUsd, at: Date.parse(e.at) }] : [];
    } catch {
      return []; // a torn or damaged line only loses that entry
    }
  });
}

/**
 * Why the escalation attempt is skipped, as its `tried:` line, or undefined to run it: not allowed by consent, limited
 * earlier in this job, or at `skipAt` (E4 `escalation_skip_at`) or more of a tracked cap (spec A7: V4 Pro's Go cap is small).
 */
export function escalationSkip(escalation: WorkerModel | undefined, c: Chain, skipAt: number, spent: Record<string, number>) {
  if (!escalation) return "esc: skipped, the escalation model is not allowed by this repo's consent";
  const name = modelName(escalation);
  if (c.limits.some((l) => l.model === name)) return `esc: skipped, ${escalation.id} hit its usage limit in this job`;
  const use = capUse(name, spent[name] ?? 0);
  if (use && use.used >= skipAt) return `esc: skipped, ${escalation.id} at ${Math.round(use.used * 100)}% of its tracked ${use.window} cap ($${use.capUsd.toFixed(2)})`;
  return undefined;
}

/**
 * Whether the job ran on pay-as-you-go balance (`billing=zen`). OpenCode reports no balance signal, so it is inferred:
 * a Go model whose tracked spend, this job included, is past a window's cap kept answering, which only balance allows.
 */
export const usedBalance = (spent: Record<string, number>) => Object.keys(spent).some((m) => (capUse(m)?.used ?? 0) > 1);
