import { consentGate, describe, writeConsent, type Consent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { isSupported, UNSUPPORTED_REASON } from "./platform.js";
import { modelName, routeModels } from "./routing.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag allow [--zdr-only | --models <provider/model,…>]";

/**
 * `cheapag allow`: the developer's opt-in for the current repo (spec: Consent). Non-interactive, so the plugin's
 * user-only `/cheapag:allow` can wrap it. No MCP tool calls this. Modes: all models (no flag), zero-retention only,
 * or an explicit model list. The consent is for the provider logged in now; a later switch asks again.
 */
export function allow(args: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  if (!isSupported()) {
    out(`✗ ${UNSUPPORTED_REASON}`);
    return 1;
  }
  let consent: Omit<Consent, "provider" | "approvedAt">;
  if (!args.length) consent = { mode: "all" };
  else if (args.length === 1 && args[0] === "--zdr-only") consent = { mode: "zdr-only" };
  else if (args.length === 2 && args[0] === "--models" && args[1].split(",").some((m) => m.trim())) {
    consent = { mode: "models", models: args[1].split(",").map((m) => m.trim()).filter(Boolean) };
  } else {
    out(`✗ ${USAGE}`);
    return 1;
  }
  const provider = detectProvider();
  if (!provider) {
    out(`✗ no worker provider; run ${LOGIN_COMMAND} first`);
    return 1;
  }
  let root: string;
  try {
    root = projectRoot(process.cwd());
  } catch (err) {
    out(`✗ ${(err as Error).message}`);
    return 1;
  }
  const record: Consent = { ...consent, provider: provider.provider, approvedAt: new Date().toISOString() };
  writeConsent(root, record);
  out(`✓ ${root}: code may go to ${providerLabel(provider.provider)} (${describe(record)})`);
  // the same gate delegate uses, so what this prints is what jobs will run
  const gate = consentGate(root, provider.provider);
  if ("block" in gate) out(`! ${gate.block}`);
  else out(`  models: ${routeModels(gate.route).map(modelName).join(", ")}`);
  return 0;
}
