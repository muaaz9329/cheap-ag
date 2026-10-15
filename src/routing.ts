import type { Provider } from "./credentials.js";

/** Routing: which model each provider's worker runs. */

/** A model as OpenCode's session.create takes it, plus per-model OpenCode options written into the generated config. */
export type WorkerModel = { providerID: string; id: string; options?: Record<string, unknown> };

// shortcut: one fixed implement model per provider; roles, fallbacks and the allowlist arrive with tickets 09/12
export const IMPLEMENT_MODEL: Record<Provider["provider"], WorkerModel> = {
  "opencode-go": { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  // listed on openrouter.ai/api/v1/models, 2026-10-15. Verified on OpenCode 1.19.0: options.provider becomes
  // OpenRouter's request-body routing preference, so upstreams that collect data are never used.
  openrouter: { providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash", options: { provider: { data_collection: "deny" } } },
  deepseek: { providerID: "deepseek", id: "deepseek-flash" },
};

export const modelName = (m: WorkerModel) => `${m.providerID}/${m.id}`;
