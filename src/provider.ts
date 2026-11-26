import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { userConfigFile } from "./config.js";
import { consentGate, describe, readConsent, writeConsent } from "./consent.js";
import {
  detectProvider,
  LOGIN_COMMAND,
  PROVIDERS,
  providerLabel,
  redact,
  usableProviders,
  type Provider,
} from "./credentials.js";
import { liveCheck, regionHint, setUserKey } from "./login.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag provider [<provider id>]";

type ProviderId = Provider["provider"];

const COVERAGE_LINE = /^(send|retention):/;

/** Redacts every line: a provider's error message can echo the key back. */
function out(line = ""): void {
  process.stdout.write(redact(line) + "\n");
}

function repoRoot(): string | undefined {
  try {
    return projectRoot(process.cwd());
  } catch {
    // outside a repo there is no consent to move
    return undefined;
  }
}

function readIfPresent(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Taken before the switch, so a failed live check can put the user config and this repo's consent back. */
function saveRollBack(root: string | undefined): () => void {
  const userFile = userConfigFile();
  const userBefore = readIfPresent(userFile);
  const consentFile = root && join(root, ".cheapag", "consent.json");
  const consentBefore = consentFile ? readIfPresent(consentFile) : undefined;
  return () => {
    if (userBefore === undefined) rmSync(userFile, { force: true });
    else writeFileSync(userFile, userBefore);
    if (consentFile && consentBefore !== undefined) writeFileSync(consentFile, consentBefore);
  };
}

/** Moves this repo's consent to `target` with the same mode and prints what it now covers. */
function moveConsent(root: string, target: ProviderId): void {
  const consent = readConsent(root);
  if (!consent || consent.provider === target) return;
  const targetLabel = providerLabel(target);
  const scope = describe(consent);
  if (consent.mode === "models") {
    // an explicit model list names the old provider's models: it cannot carry over
    const oldLabel = providerLabel(consent.provider);
    out(
      `! This repo's consent names ${oldLabel} models (${scope}); run /cheapag:allow here for ${targetLabel}`,
    );
    return;
  }
  // what the user is agreeing to now: the new recipients and their retention, as /cheapag:allow would show them
  const gate = consentGate(root, target);
  const shown =
    "block" in gate ? gate.block.split("\n").filter((line) => COVERAGE_LINE.test(line)) : [];
  writeConsent(root, {
    mode: consent.mode,
    provider: target,
    approvedAt: new Date().toISOString(),
  });
  out(`✓ ${basename(root)}: consent moved to ${targetLabel} (${scope}); it now covers:`);
  for (const line of shown) out(`  ${line}`);
}

function listProviders(usable: ProviderId[], current: ProviderId | undefined): number {
  if (!usable.length) {
    out(`✗ no provider set up; run ${LOGIN_COMMAND}`);
    return 1;
  }
  out("Providers set up:");
  for (const id of usable) {
    const inUse = id === current ? "  (in use)" : "";
    out(`  ${id}  ${providerLabel(id)}${inUse}`);
  }
  const missing = PROVIDERS.filter(({ id }) => !usable.includes(id)).map(({ label }) => label);
  if (missing.length) out(`Not set up: ${missing.join(", ")}. Add one with ${LOGIN_COMMAND}`);
  return 0;
}

/** Takes an id or a label in any case, as users type either. */
function findProvider(name: string): ProviderId | undefined {
  const wanted = name.toLowerCase();
  return PROVIDERS.find(({ id, label }) => id === wanted || label.toLowerCase() === wanted)?.id;
}

/**
 * `cheapag provider`: lists the providers already set up, or switches the worker to one of them with no key prompt
 * (ticket 47). The switch moves this repo's consent to the new provider with the same mode and prints what it now
 * covers, then live-checks the new provider; a failed check puts the previous provider and consent back.
 */
export async function provider(args: string[]): Promise<number> {
  const usable = usableProviders();
  const current = detectProvider()?.provider;
  if (!args.length || (args.length === 1 && args[0] === "--list"))
    return listProviders(usable, current);
  if (args.length !== 1) {
    out(`✗ ${USAGE}`);
    return 1;
  }
  const target = findProvider(args[0]);
  if (!target) {
    const ids = PROVIDERS.map(({ id }) => id).join(", ");
    out(`✗ "${args[0]}" is not a provider; use one of ${ids}`);
    return 1;
  }
  if (!usable.includes(target)) {
    const label = providerLabel(target);
    out(`✗ ${label} is not set up yet; run ${LOGIN_COMMAND} and pick it (the key is typed there)`);
    return 1;
  }
  if (target === current) {
    out(`✓ already using ${providerLabel(target)}`);
    return 0;
  }
  return switchProvider(target, current);
}

async function switchProvider(
  target: ProviderId,
  current: ProviderId | undefined,
): Promise<number> {
  const root = repoRoot();
  const rollBack = saveRollBack(root);

  if (!setUserKey("provider", target, out)) return 1;
  const targetLabel = providerLabel(target);
  const fromLabel = current ? providerLabel(current) : "nothing";
  out(`Switching the worker from ${fromLabel} to ${targetLabel}`);
  if (root) moveConsent(root, target);

  const via = target === "local" || target === "ollama" ? "config" : "login";
  const check = await liveCheck({ provider: target, via });
  if (!check.ok) {
    rollBack();
    out(`✗ ${check.line}`);
    const hint = regionHint(check.line);
    if (hint) out(hint);
    const keptLabel = current ? providerLabel(current) : "no provider";
    out(`Still using ${keptLabel}; nothing changed`);
    return 1;
  }
  out(`✓ ${check.line}`);
  out(`✓ Now using ${targetLabel}; the next job runs on it`);
  return 0;
}
