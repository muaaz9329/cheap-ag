import type { Provider } from "./credentials.js";

/** Routing: which model each provider's worker runs. */

/** A model as OpenCode's session.create takes it, plus per-model OpenCode options written into the generated config. */
export type WorkerModel = { providerID: string; id: string; options?: Record<string, unknown> };

// verified on OpenCode 1.19.0: options.provider becomes OpenRouter's request-body routing preference, so upstreams that
// collect data are never used. Every OpenRouter model carries it.
const OPENROUTER_PRIVATE = { provider: { data_collection: "deny" } };

// shortcut: one fixed implement model per provider; roles and fallbacks arrive with ticket 12
export const IMPLEMENT_MODEL: Record<Provider["provider"], WorkerModel> = {
  "opencode-go": { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  openrouter: { providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash", options: OPENROUTER_PRIVATE }, // on openrouter.ai/api/v1/models, 2026-10-15
  deepseek: { providerID: "deepseek", id: "deepseek-flash" },
};

/** The stronger (still cheap) model for a job's one escalation attempt. Its cap-based skip arrives with ticket 12. */
// Go and DeepSeek ids are the spec's (E3/E4), not yet seen live; OpenRouter's is on openrouter.ai/api/v1/models, 2026-10-15
export const ESCALATION_MODEL: Record<Provider["provider"], WorkerModel> = {
  "opencode-go": { providerID: "opencode-go", id: "deepseek-v4-pro" },
  openrouter: { providerID: "openrouter", id: "deepseek/deepseek-v4-pro", options: OPENROUTER_PRIVATE },
  deepseek: { providerID: "deepseek", id: "deepseek-v4-pro" },
};

// ticket 13, minimal until ticket 12's role table: the research role's default model (spec: Models and limits). Its one
// fallback is the implement model (DeepSeek V4.1 Flash), see src/research.ts. Go's id is the spec's (E4), not yet seen
// live; OpenRouter's is unverified; DeepSeek serves no Qwen, so research there runs the implement model.
export const RESEARCH_MODEL: Record<Provider["provider"], WorkerModel> = {
  "opencode-go": { providerID: "opencode-go", id: "qwen3.8-flash" },
  openrouter: { providerID: "openrouter", id: "qwen/qwen3.8-flash", options: OPENROUTER_PRIVATE },
  deepseek: IMPLEMENT_MODEL.deepseek,
};

/**
 * The models one job may run: the implement model and, unless the allowlist drops them, the escalation and research
 * models (src/consent.ts).
 */
export type Route = { implement: WorkerModel; escalation?: WorkerModel; research?: WorkerModel };

/** Every model a provider's worker may run, before the repo's allowlist filters them. */
export const fullRoute = (provider: Provider["provider"]): Route =>
  ({ implement: IMPLEMENT_MODEL[provider], escalation: ESCALATION_MODEL[provider], research: RESEARCH_MODEL[provider] });

export const modelName = (m: WorkerModel) => `${m.providerID}/${m.id}`;
