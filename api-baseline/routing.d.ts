import { type Config } from "./config.js";
import { type Provider } from "./credentials.js";
import type { RunResult, Session } from "./worker.js";
/** Routing: which model each role runs, fallbacks on provider limits, escalation eligibility, and the local spend ledger. */
/** A model as OpenCode's session.create takes it, plus per-model OpenCode options written into the generated config. */
export type WorkerModel = {
    providerID: string;
    id: string;
    options?: Record<string, unknown>;
    variant?: string;
};
type ProviderId = Provider["provider"];
/**
 * Default models per provider and role (spec: Models and limits): each list is the role's model, then its fallbacks.
 * Go and DeepSeek ids are in OpenCode 1.19.0's bundled model catalog; OpenRouter's are on openrouter.ai/api/v1/models
 * (checked 2026-10-16). Direct DeepSeek has no other models to fall back to.
 */
export declare const ROLES: Record<Exclude<ProviderId, "local">, {
    implement: string[];
    research: string[];
    escalation: string;
}>;
/** `cheapag login`'s worker-model presets (ticket 27): a named `models` per provider; roles a preset leaves out keep the defaults above. */
export declare const PRESET_NAMES: readonly ["cheapest", "balanced", "strongest"];
export type Preset = (typeof PRESET_NAMES)[number];
export declare const PRESETS: Record<Exclude<ProviderId, "local">, Record<Preset, ModelsConfig>>;
/** Whether the provider is the config-based local endpoint (the custom endpoint, or Ollama on this machine): no presets. */
export declare function localEndpoint(provider: ProviderId): boolean;
/** The preset whose route `models` gives on this provider, else custom (`preset=` in ping and status); a tie names balanced, the default. */
export declare function presetOf(provider: ProviderId, models?: ModelsConfig): Preset | "custom";
/**
 * The models one job may run. `fallbacks` continue the session, in order, when the current model hits a provider limit;
 * the escalation model has none. Ticket 13's research uses `research` then `researchFallbacks`.
 */
export type Route = {
    implement: WorkerModel;
    fallbacks: WorkerModel[];
    escalation?: WorkerModel;
    research?: WorkerModel;
    researchFallbacks: WorkerModel[];
    /** Ticket 26: the implement model for a `medium` or `hard` difficulty hint; absent = `implement`. */
    medium?: WorkerModel;
    hard?: WorkerModel;
};
/** Config (spec E4) `models`: full `provider/model` names; a role set for another provider than the one logged in is ignored. */
export type ModelsConfig = {
    implement?: string;
    medium?: string;
    hard?: string;
    research?: string;
    escalation?: string;
    fallback?: string[];
    variants?: Record<string, string>;
};
/** Claude's rating of a task from the issue (ticket 26): easy < 15 min, medium < 1 h, hard > 1 h of an engineer new to the code. */
export declare const DIFFICULTIES: readonly ["easy", "medium", "hard"];
export type Difficulty = (typeof DIFFICULTIES)[number];
/** The model a job implements on: hard takes the hard model, else the medium one; medium the medium one; easy or no hint `implement`. */
export declare const tierModel: (r: Route, d?: Difficulty) => WorkerModel;
/** The models config in force: the chosen preset's models (none for a local endpoint) with an explicit `models` role winning over it. */
export declare function effectiveModels(provider: ProviderId, config: Pick<Config, "preset" | "models">): ModelsConfig;
/** A `models` entry that names another provider, which `fullRoute` has to ignore: the silent-mismatch warning (issue #27). */
export type ForeignModel = {
    role: "implement" | "medium" | "hard" | "research" | "escalation" | "fallback";
    name: string;
};
export declare function foreignModels(provider: ProviderId, models?: ModelsConfig): ForeignModel[];
/** Every model a provider's worker may run, defaults overridden by the config, before the repo's allowlist filters them. */
export declare function fullRoute(provider: ProviderId, models?: ModelsConfig): Route;
/** Every distinct model a route may send code to, first to last (for the config, the CONSENT block and `cheapag allow`). */
export declare const routeModels: (r: Route) => WorkerModel[];
export declare const modelName: (m: WorkerModel) => string;
/** What one run hit instead of finishing: a provider limit (Go window, free tier, or a plain rate limit), from OpenCode's retry status. */
export type Limit = {
    model: string;
    reason?: string;
    message: string;
    next: number;
};
/** A role's model chain within one job: the model the session runs on now, the fallbacks left, and what was hit. */
export type Chain = {
    first: WorkerModel;
    current: WorkerModel;
    rest: WorkerModel[];
    limits: Limit[];
    used: string[];
};
export declare const chain: (first: WorkerModel, fallbacks: WorkerModel[]) => Chain;
/**
 * One prompt on the chain's current model. On a provider limit the worker has already aborted the session (never waiting
 * out the retry); the same session continues on the next fallback. A transient provider error is retried once in a forked
 * session, then stops with `provider`: the user chooses, no silent fallback. `budget` is set when the job must stop as BUDGET: every allowed model is limited, or
 * (OpenRouter) the credit is gone, which no other model can help with. `provider` is set when the current model keeps failing
 * instead. With `escalation`, the prompt runs on that model alone: a limit there is returned (in `limit`),
 * never fallen back from, and a transient error is not retried either.
 */
export declare function runRouted(session: Pick<Session, "run" | "rotate">, prompt: string, c: Chain, provider: ProviderId, escalation?: WorkerModel, interrupt?: AbortSignal): Promise<RunResult & {
    budget?: string;
    provider?: string;
}>;
/** Local time as HH:MM, with the date in front when it is not today. */
export declare function clock(ms: number): string;
/**
 * The ledger is per user, not per repo: Go's windows are per account, so every repo's jobs draw on the same caps.
 * One JSON line per model per job: `{at, model, costUsd}`.
 * shortcut: never pruned (a line per job and model); trim entries older than the monthly window if it ever grows large.
 */
export declare const ledgerFile: () => string;
export declare function recordSpend(spend: Record<string, number>): void;
/** A model's fullest tracked window: the share of its cap used (plus `extra` not yet recorded); undefined without a known cap. */
export declare function capUse(name: string, extra?: number): {
    used: number;
    window: string;
    capUsd: number;
} | undefined;
/** Tracked spend per model and window, with the window's cap where Go has one (for `cheapag status`); models unspent this month are left out. */
export declare function spendWindows(now?: number): {
    model: string;
    windows: {
        window: string;
        spent: number;
        capUsd: number | undefined;
    }[];
}[];
/**
 * Why the escalation attempt is skipped, as its `tried:` line, or undefined to run it: not allowed by consent, limited
 * earlier in this job, or at `skipAt` (E4 `escalation_skip_at`) or more of a tracked cap (spec A7: V4 Pro's Go cap is small).
 */
export declare function escalationSkip(escalation: WorkerModel | undefined, c: Chain, skipAt: number, spent: Record<string, number>): string | undefined;
/**
 * Whether the job ran on pay-as-you-go balance (`billing=zen`). OpenCode reports no balance signal, so it is inferred:
 * a Go model whose tracked spend, this job included, is past a window's cap kept answering, which only balance allows.
 */
export declare const usedBalance: (spent: Record<string, number>) => boolean;
export {};
