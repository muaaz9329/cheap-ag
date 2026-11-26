import { type Provider } from "./credentials.js";
import { type Route } from "./routing.js";
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
/** The repo's consent, or undefined when there is none (a damaged record counts as none; `cheapag allow` rewrites it). */
export declare function readConsent(root: string): Consent | undefined;
export declare function writeConsent(root: string, consent: Consent): void;
/** Records the current route as the repo's consented one (after a model pick on OpenRouter); nothing without consent. */
export declare function acceptRoute(root: string): void;
/**
 * The models config now routes to other models than the consent was shown (not judged on a damaged config, which the job's own load reports; a record from before routes were kept has none).
 * Within one provider the code goes to the same company, so a model change never asks again; OpenRouter (the model picks the upstream)
 * and a local server (a URL is a recipient) keep the route check.
 */
export declare function routeMoved(root: string, consent: Consent): boolean;
/** `preset=` for ping and status: the preset the effective `models` here match (the repo's config too, inside one). */
export declare function presetHere(provider: Provider["provider"], cwd?: string): "balanced" | "cheapest" | "custom" | "strongest";
/**
 * Issue #27: a `models.*` entry naming another provider is silently ignored by `fullRoute`, so a job runs on something
 * else than the config says. Say it, and name the model the worker actually runs.
 */
export declare function modelWarnings(provider: Provider["provider"], root?: string): string[];
/**
 * The repo's consent gate, for delegate and research. Call it before anything is created or booted:
 * - `block`: the CONSENT block (not approved for this provider) or a FAIL (approved, but no allowed model);
 * - `route`: the allowlisted models the job may use, every role and fallback filtered. A disallowed fallback or escalation
 *   model is dropped, not a failure; with no implement model or fallback allowed, an allowed escalation model implements.
 */
export declare function consentGate(root: string, provider: Provider["provider"]): {
    block: string;
} | {
    route: Route;
};
export declare const describe: (c: Consent) => string;
