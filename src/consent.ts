import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { providerLabel, type Provider } from "./credentials.js";
import { failBlock, renderConsent } from "./report.js";
import { fullRoute, modelName, type Route, type WorkerModel } from "./routing.js";

/**
 * Consent: nothing leaves the repo until the developer opts in with `cheapag allow` (spec: Consent, A21).
 * The record is `<repo>/.cheapag/consent.json`; only the CLI writes it, no MCP tool can.
 */

export type ConsentMode = "all" | "zdr-only" | "models";
export type Consent = { mode: ConsentMode; provider: Provider["provider"]; models?: string[]; approvedAt: string };

const file = (root: string) => join(root, ".cheapag", "consent.json");

/** The repo's consent, or undefined when there is none (a damaged record counts as none; `cheapag allow` rewrites it). */
export function readConsent(root: string): Consent | undefined {
  try {
    if (!existsSync(file(root))) return undefined;
    const c = JSON.parse(readFileSync(file(root), "utf8")) as Consent;
    const valid = ["all", "zdr-only", "models"].includes(c.mode) && typeof c.provider === "string" &&
      (c.mode !== "models" || (Array.isArray(c.models) && c.models.every((m) => typeof m === "string")));
    return valid ? c : undefined;
  } catch {
    return undefined;
  }
}

export function writeConsent(root: string, consent: Consent) {
  mkdirSync(join(root, ".cheapag"), { recursive: true });
  writeFileSync(file(root), JSON.stringify(consent, null, 2) + "\n");
}

// OpenRouter's provider-routing preference that restricts it to Zero Data Retention endpoints (openrouter.ai/docs, provider routing)
const ZDR_OPTION = { zdr: true };

/** What is known about a model's retention: only the spec's facts (A21), never guessed. */
function retention(provider: Provider["provider"], m: WorkerModel): "zero" | "upstream" | "not stated" {
  if (provider === "openrouter") return "upstream"; // depends on the endpoint OpenRouter routes to
  // A21: on OpenCode Go, DeepSeek and Qwen models are zero-retention; GLM and Kimi are not listed that way
  if (provider === "opencode-go" && /^(deepseek|qwen)/.test(m.id)) return "zero";
  return "not stated";
}

/** Whether a model may run under the consent; on OpenRouter, zero-retention-only is enforced by its zdr routing instead. */
function allowed(provider: Provider["provider"], consent: Consent, m: WorkerModel) {
  if (consent.mode === "all") return true;
  if (consent.mode === "models") return consent.models!.includes(modelName(m));
  return provider === "openrouter" || retention(provider, m) === "zero";
}

/** With zero-retention-only on OpenRouter, every request also asks for ZDR endpoints. */
function withZdr(m: WorkerModel): WorkerModel {
  const options = m.options as { provider?: Record<string, unknown> } | undefined;
  return { ...m, options: { ...options, provider: { ...options?.provider, ...ZDR_OPTION } } };
}

/**
 * The repo's consent gate, for delegate and (ticket 13) research. Call it before anything is created or booted:
 * - `block`: the CONSENT block (not approved for this provider) or a FAIL (approved, but no allowed model);
 * - `route`: the allowlisted models the job may use. A disallowed escalation model is dropped, not a failure.
 */
export function consentGate(root: string, provider: Provider["provider"]): { block: string } | { route: Route } {
  const consent = readConsent(root);
  // consent names the provider it was given for: a new login elsewhere needs a new opt-in
  if (!consent || consent.provider !== provider) return { block: consentBlock(root, provider) };
  const full = fullRoute(provider);
  const zdr = consent.mode === "zdr-only" && provider === "openrouter";
  const pick = (m?: WorkerModel) => (m && allowed(provider, consent, m) ? (zdr ? withZdr(m) : m) : undefined);
  // shortcut: the implement model falls back to the escalation model when only that is allowed; ticket 12 adds role fallbacks
  const implement = pick(full.implement) ?? pick(full.escalation);
  const escalation = pick(full.escalation);
  if (!implement) return { block: failBlock(`no allowed model for ${providerLabel(provider)} under this repo's consent (${describe(consent)}); ask the user to widen it with /cheapag:allow`) };
  return { route: { implement, escalation: escalation && modelName(escalation) !== modelName(implement) ? escalation : undefined } };
}

export const describe = (c: Consent) => (c.mode === "all" ? "all models" : c.mode === "zdr-only" ? "zero-retention only" : `models ${c.models!.join(", ")}`);

/** Spec D5's CONSENT block: who would receive the code, their known retention, and how the user approves. */
function consentBlock(root: string, provider: Provider["provider"]) {
  const full = fullRoute(provider);
  const models = [full.implement, full.escalation].filter((m): m is WorkerModel => !!m);
  const ids = models.map((m) => m.id).join(", ");
  // shortcut: lists the implement and escalation models only; ticket 12 adds "(+fallbacks …)"
  const retentionLine = provider === "openrouter"
    ? `depends on the upstream provider OpenRouter routes to; "deny data collection" is always on; --zdr-only adds OpenRouter's zero-data-retention routing (zdr)`
    : models.map((m) => `${m.id} = ${retention(provider, m) === "zero" ? "zero retention" : "not stated"}`).join("; ");
  return renderConsent({
    repo: basename(root),
    send: `code from this repo → ${providerLabel(provider)}: ${ids}`,
    retention: retentionLine,
    approve: "ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only (terminal: npx cheap-agent allow [--zdr-only | --models a,b]); never approve yourself",
  });
}
