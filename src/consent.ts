import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { providerLabel, type Provider } from "./credentials.js";
import { failBlock, renderConsent } from "./report.js";
import {
  loadConfig,
  localServer,
  ollamaEndpoint,
  ollamaIsLocal,
  type LocalServer,
  type OllamaConfig,
} from "./config.js";
import {
  effectiveModels,
  foreignModels,
  fullRoute,
  modelName,
  presetOf,
  routeModels,
  type Route,
  type WorkerModel,
} from "./routing.js";
import { projectRoot } from "./workspace.js";

/**
 * Consent: nothing leaves the repo until the developer opts in with `cheapag allow` (spec: Consent, A21).
 * The record is `<repo>/.cheapag/consent.json`; only the CLI writes it, no MCP tool can.
 */

export type ConsentMode = "all" | "zdr-only" | "models";
/** `route`: the models the CONSENT block listed when all or zero-retention was given; a preset or `models` change that alters it asks again. */
export type Consent = {
  mode: ConsentMode;
  provider: Provider["provider"];
  models?: string[];
  route?: string[];
  approvedAt: string;
};

const file = (root: string) => join(root, ".cheapag", "consent.json");

/** The repo's consent, or undefined when there is none (a damaged record counts as none; `cheapag allow` rewrites it). */
export function readConsent(root: string): Consent | undefined {
  const path = file(root);
  if (!existsSync(path)) return undefined;
  const stored = readJson(path);
  return isConsent(stored) ? stored : undefined;
}

/** The file's parsed JSON, or undefined when it cannot be read or parsed (a damaged record counts as none). */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const MODES = ["all", "zdr-only", "models"];

/** A stored record is a consent when its mode and provider are set; the models mode needs its list of names too. */
function isConsent(value: unknown): value is Consent {
  if (typeof value !== "object" || value === null) return false;
  const { mode, provider, models } = value as Record<string, unknown>;
  if (typeof mode !== "string" || !MODES.includes(mode)) return false;
  if (typeof provider !== "string") return false;
  if (mode !== "models") return true;
  return Array.isArray(models) && models.every((name) => typeof name === "string");
}

export function writeConsent(root: string, consent: Consent) {
  mkdirSync(join(root, ".cheapag"), { recursive: true });
  // an explicit model list bounds the recipients by itself; the other modes are tied to the route they were shown
  const route =
    consent.mode === "models"
      ? undefined
      : routeNames(fullRoute(consent.provider, configuredModels(root, consent.provider)));
  writeFileSync(file(root), JSON.stringify({ ...consent, route }, null, 2) + "\n");
}

/** Records the current route as the repo's consented one (after a model pick on OpenRouter); nothing without consent. */
export function acceptRoute(root: string) {
  const consent = readConsent(root);
  if (consent) writeConsent(root, consent);
}

// a local model is named with its server: pointing the same model id at another URL is another recipient
function routeNames(r: Route) {
  const url = recipientUrl(r.implement.providerID);
  return routeModels(r).map((m) => modelName(m) + (url ? `@${url}` : ""));
}

/** The server URL that is part of the recipient: the custom endpoint's or a local Ollama's; none for a hosted provider. */
function recipientUrl(provider: string) {
  if (provider === "local") return localServer()?.base_url;
  if (provider === "ollama" && ollamaIsLocal()) return ollamaEndpoint()?.base_url;
  return undefined;
}

/**
 * The models config now routes to other models than the consent was shown (not judged on a damaged config, which the job's own load reports; a record from before routes were kept has none).
 * Within one provider the code goes to the same company, so a model change never asks again; OpenRouter (the model picks the upstream)
 * and a local server (a URL is a recipient) keep the route check.
 */
export function routeMoved(root: string, consent: Consent) {
  // within one provider the code goes to the same company; OpenRouter (the model picks the upstream), the custom
  // endpoint and a local Ollama (a URL is a recipient) keep the route check
  const checksRoute =
    consent.provider === "openrouter" ||
    consent.provider === "local" ||
    (consent.provider === "ollama" && ollamaIsLocal());
  if (!checksRoute) return false;
  const models = configuredModels(root, consent.provider);
  if (!models || !consent.route) return false;
  const current = routeNames(fullRoute(consent.provider, models));
  return String(consent.route) !== String(current);
}

/** `preset=` for ping and status: the preset the effective `models` here match (the repo's config too, inside one). */
export function presetHere(provider: Provider["provider"], cwd = process.cwd()) {
  return presetOf(provider, configuredModels(configRoot(cwd), provider));
}

/** The root of the repo `cwd` is in, or `cwd` itself outside a repo. */
function configRoot(cwd: string) {
  try {
    return projectRoot(cwd);
  } catch {
    return cwd; // outside a repo only the user's config applies
  }
}

/**
 * Issue #27: a `models.*` entry naming another provider is silently ignored by `fullRoute`, so a job runs on something
 * else than the config says. Say it, and name the model the worker actually runs.
 */
export function modelWarnings(provider: Provider["provider"], root = process.cwd()): string[] {
  try {
    const models = configuredModels(root, provider) ?? {};
    const route = fullRoute(provider, models);
    return foreignModels(provider, models).map(
      ({ role, name }) =>
        `models.${role} names ${name}, which is not a model on ${providerLabel(provider)}; it is ignored and the worker runs ${modelName(route.implement)}. Fix it in cheapag.json or run npx cheap-agent model`,
    );
  } catch {
    return []; // a damaged config is reported by the job's own load
  }
}

// OpenRouter's provider-routing preference that restricts it to Zero Data Retention endpoints (openrouter.ai/docs, provider routing)
const ZDR_OPTION = { zdr: true };

/** What is known about a model's retention: only the spec's facts (A21), never guessed. */
function retention(
  provider: Provider["provider"],
  m: WorkerModel,
): "zero" | "upstream" | "not stated" {
  // Ollama on this machine sends nothing; Ollama Cloud's terms are not stated here (never guessed)
  if (provider === "ollama") return ollamaIsLocal() ? "zero" : "not stated";
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
 * The repo's consent gate, for delegate and research. Call it before anything is created or booted:
 * - `block`: the CONSENT block (not approved for this provider) or a FAIL (approved, but no allowed model);
 * - `route`: the allowlisted models the job may use, every role and fallback filtered. A disallowed fallback or escalation
 *   model is dropped, not a failure; with no implement model or fallback allowed, an allowed escalation model implements.
 */
export function consentGate(
  root: string,
  provider: Provider["provider"],
): { block: string } | { route: Route } {
  const consent = readConsent(root);
  const full = fullRoute(provider, configuredModels(root, provider));
  // consent names the provider it was given for: a new login elsewhere needs a new opt-in; so does another route
  if (!consent || consent.provider !== provider || routeMoved(root, consent))
    return { block: consentBlock(root, provider, full) };
  const route = allowedRoute(full, provider, consent);
  if (route) return { route };
  return {
    block: failBlock(
      `no allowed model for ${providerLabel(provider)} under this repo's consent (${describe(consent)}); ask the user to widen it with /cheapag:allow`,
    ),
  };
}

/** The full route with every role and fallback the consent does not allow taken out; undefined when no model may implement. */
function allowedRoute(full: Route, provider: Provider["provider"], consent: Consent) {
  const zdr = consent.mode === "zdr-only" && provider === "openrouter";
  const pick = (ms: (WorkerModel | undefined)[]) =>
    ms
      .filter((m): m is WorkerModel => !!m && allowed(provider, consent, m))
      .map((m) => (zdr ? withZdr(m) : m));
  const [implement, ...fallbacks] = pick([full.implement, ...full.fallbacks, full.escalation]);
  if (!implement) return undefined;
  const [escalation] = pick([full.escalation]);
  const notImplementOrEscalation = (m: WorkerModel) =>
    modelName(m) !== modelName(implement) && modelName(m) !== modelName(escalation ?? implement);
  // research with nothing of its own allowed runs on the implement chain
  const [research, ...researchFallbacks] = pick([full.research, ...full.researchFallbacks]);
  return {
    implement,
    // the escalation model never doubles as a fallback; it keeps its own place (and cap check) in the job
    fallbacks: fallbacks.filter(notImplementOrEscalation),
    escalation:
      escalation && modelName(escalation) !== modelName(implement) ? escalation : undefined,
    research: research ?? implement,
    researchFallbacks: research ? researchFallbacks : fallbacks.filter(notImplementOrEscalation),
    // a disallowed tier model is dropped: that tier then runs on the implement model
    medium: pick([full.medium])[0],
    hard: pick([full.hard])[0],
  };
}

/** The config's effective `models` (E4, preset included); a damaged config counts as none here, the job's own config load reports it. */
function configuredModels(root: string, provider: Provider["provider"]) {
  try {
    const config = loadConfig(root);
    return effectiveModels(provider, config);
  } catch {
    return undefined;
  }
}

export const describe = (c: Consent) => {
  if (c.mode === "all") return "all models";
  if (c.mode === "zdr-only") return "zero-retention only";
  return `models ${c.models!.join(", ")}`;
};

/** Spec D5's CONSENT block: who would receive the code, their known retention, and how the user approves. */
function consentBlock(root: string, provider: Provider["provider"], full: Route) {
  const models = routeModels(full);
  // D5: the role models, then the fallbacks
  const main = routeModels({ ...full, fallbacks: [], researchFallbacks: [] }).map((m) => m.id);
  const extra = models.map((m) => m.id).filter((id) => !main.includes(id));
  const ids = main.join(", ") + (extra.length ? ` (+fallbacks ${extra.join(", ")})` : "");
  const endpoints = {
    local: provider === "local" ? localServer() : undefined,
    ollama: provider === "ollama" ? configuredOllama() : undefined,
  };
  const recipient = recipientName(provider, endpoints);
  return renderConsent({
    repo: basename(root),
    send: `code from this repo → ${recipient}: ${ids}`,
    retention: retentionLine(provider, models, endpoints),
    approve: sessionRepo(root) ? APPROVE_IN_SESSION : APPROVE_IN_TERMINAL,
  });
}

const APPROVE_IN_SESSION =
  "ask the user to run /cheapag:allow in Claude Code, or npx cheap-agent allow in a terminal (Codex); add --zdr-only to limit it to zero-retention models, or --models a,b; never approve yourself";
// the caller passed the root, so "this root" names it; a path here would push the line past the 200-char cap
const APPROVE_IN_TERMINAL =
  "ask the user to run npx cheap-agent allow in a terminal in this root (/cheapag:allow approves the session's repo); add --zdr-only or --models a,b to narrow it; never approve yourself";

/** The config-based endpoint the provider sends to, if it is one; at most one is set. */
type Endpoints = { local: LocalServer | undefined; ollama: OllamaConfig | undefined };

/** The Ollama endpoint, or none when its entry is damaged. */
function configuredOllama() {
  try {
    return ollamaEndpoint();
  } catch {
    return undefined; // a damaged entry is reported by the config load, not as a consent line
  }
}

/** Who receives the code: this machine's Ollama, Ollama Cloud, the custom endpoint, or the provider itself. */
function recipientName(provider: Provider["provider"], endpoints: Endpoints) {
  const { local, ollama } = endpoints;
  if (ollama?.endpoint === "local") return `your local Ollama at ${ollama.base_url}`;
  if (ollama) return "Ollama Cloud (ollama.com)";
  if (local) return `custom endpoint at ${local.base_url}`;
  return providerLabel(provider);
}

/** What is known about how long the recipient keeps the code (A21's facts, never guessed). */
function retentionLine(
  provider: Provider["provider"],
  models: WorkerModel[],
  endpoints: Endpoints,
) {
  const { local, ollama } = endpoints;
  if (provider === "openrouter")
    return `depends on the upstream provider OpenRouter routes to; "deny data collection" is always on; --zdr-only adds OpenRouter's zero-data-retention routing (zdr)`;
  if (ollama?.endpoint === "local")
    return "nothing leaves this machine: your own Ollama keeps what it is set up to keep";
  if (ollama) return "Ollama Cloud's terms (ollama.com); retention is not stated here";
  if (local)
    return `up to the endpoint: your own server keeps what it is set up to keep; a gateway or vendor keeps what its terms say`;
  return models
    .map((m) => `${m.id} = ${retention(provider, m) === "zero" ? "zero retention" : "not stated"}`)
    .join("; ");
}

/** Whether `root` is the repo the server (the session) runs in, which is the one /cheapag:allow approves. */
function sessionRepo(root: string) {
  try {
    return projectRoot(process.cwd()) === root;
  } catch {
    return false; // the session is outside any repo: only a terminal in `root` can approve it
  }
}
