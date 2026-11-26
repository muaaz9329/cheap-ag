import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { consentGate, describe, writeConsent, type Consent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { modelName, routeModels } from "./routing.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag allow [--zdr-only | --models <provider/model,…>]";

type ConsentChoice = Omit<Consent, "provider" | "approvedAt">;

function parseConsentChoice(args: string[]): ConsentChoice | undefined {
  if (!args.length) return { mode: "all" };
  if (args.length === 1 && args[0] === "--zdr-only") return { mode: "zdr-only" };
  if (args.length !== 2 || args[0] !== "--models") return undefined;
  const models = args[1]
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (!models.length) return undefined;
  return { mode: "models", models };
}

/**
 * `cheapag allow`: the developer's opt-in for the current repo (spec: Consent). Non-interactive, so the plugin's
 * user-only `/cheapag:allow` can wrap it. No MCP tool calls this. Modes: all models (no flag), zero-retention only,
 * or an explicit model list. The consent is for the provider logged in now; a later switch asks again.
 */
export function allow(args: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  const choice = parseConsentChoice(args);
  if (!choice) {
    out(`✗ ${USAGE}`);
    return 1;
  }
  const detected = detectProvider();
  if (!detected) {
    out(`✗ no worker provider; run ${LOGIN_COMMAND} first`);
    return 1;
  }
  const { provider } = detected;
  let root: string;
  try {
    root = projectRoot(process.cwd());
  } catch (error) {
    out(`✗ ${(error as Error).message}`);
    return 1;
  }
  const record: Consent = {
    ...choice,
    provider,
    approvedAt: new Date().toISOString(),
  };
  writeConsent(root, record);
  out(`✓ ${root}: code may go to ${providerLabel(provider)} (${describe(record)})`);
  // the same gate delegate uses, so what this prints is what jobs will run
  const gate = consentGate(root, provider);
  if ("block" in gate) out(`! ${gate.block}`);
  else out(`  models: ${routeModels(gate.route).map(modelName).join(", ")}`);
  if (!isStateFolderIgnored(root)) {
    excludeStateFolder(root);
    out("✓ .cheapag/ added to .git/info/exclude (local, never committed)");
  }
  return 0;
}

function isStateFolderIgnored(root: string): boolean {
  const check = spawnSync("git", ["check-ignore", "-q", ".cheapag"], { cwd: root, stdio: "pipe" });
  return check.status === 0;
}

// .cheapag/ state is local: keep it out of `git status` without touching the repo's tracked .gitignore
function excludeStateFolder(root: string) {
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  appendFileSync(join(root, ".git", "info", "exclude"), ".cheapag/\n");
}
