import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { userConfigFile } from "./config.js";
import { consentGate, describe, readConsent, writeConsent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, PROVIDERS, providerLabel, redact, usableProviders, type Provider } from "./credentials.js";
import { liveCheck, regionHint, setUserKey } from "./login.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag provider [<provider id>]";

/**
 * `cheapag provider`: lists the providers already set up, or switches the worker to one of them with no key prompt
 * (ticket 47). The switch moves this repo's consent to the new provider with the same mode and prints what it now
 * covers, then live-checks the new provider; a failed check puts the previous provider and consent back.
 */
export async function provider(args: string[]): Promise<number> {
  const out = (line = "") => process.stdout.write(redact(line) + "\n");
  const usable = usableProviders();
  const current = detectProvider()?.provider;
  if (!args.length || (args.length === 1 && args[0] === "--list")) {
    if (!usable.length) {
      out(`✗ no provider set up; run ${LOGIN_COMMAND}`);
      return 1;
    }
    out("Providers set up:");
    for (const id of usable) out(`  ${id}  ${providerLabel(id)}${id === current ? "  (in use)" : ""}`);
    const missing = PROVIDERS.filter((p) => !usable.includes(p.id)).map((p) => p.label);
    if (missing.length) out(`Not set up: ${missing.join(", ")}. Add one with ${LOGIN_COMMAND}`);
    return 0;
  }
  if (args.length !== 1) {
    out(`✗ ${USAGE}`);
    return 1;
  }
  const wanted = args[0].toLowerCase();
  const target = PROVIDERS.find((p) => p.id === wanted || p.label.toLowerCase() === wanted)?.id;
  if (!target) {
    out(`✗ "${args[0]}" is not a provider; use one of ${PROVIDERS.map((p) => p.id).join(", ")}`);
    return 1;
  }
  if (!usable.includes(target)) {
    out(`✗ ${providerLabel(target)} is not set up yet; run ${LOGIN_COMMAND} and pick it (the key is typed there)`);
    return 1;
  }
  if (target === current) {
    out(`✓ already using ${providerLabel(target)}`);
    return 0;
  }

  // what to put back if the new provider fails its live check
  const userFile = userConfigFile();
  const userBefore = existsSync(userFile) ? readFileSync(userFile, "utf8") : undefined;
  let root: string | undefined;
  try {
    root = projectRoot(process.cwd());
  } catch {} // outside a repo there is no consent to move
  const consentFile = root && join(root, ".cheapag", "consent.json");
  const consentBefore = consentFile && existsSync(consentFile) ? readFileSync(consentFile, "utf8") : undefined;
  const rollBack = () => {
    if (userBefore === undefined) rmSync(userFile, { force: true });
    else writeFileSync(userFile, userBefore);
    if (consentFile && consentBefore !== undefined) writeFileSync(consentFile, consentBefore);
  };

  if (!setUserKey("provider", target, out)) return 1;
  out(`Switching the worker from ${current ? providerLabel(current) : "nothing"} to ${providerLabel(target)}`);
  const consent = root ? readConsent(root) : undefined;
  if (root && consent && consent.provider !== target) {
    if (consent.mode === "models") {
      // an explicit model list names the old provider's models: it cannot carry over
      out(`! This repo's consent names ${providerLabel(consent.provider)} models (${describe(consent)}); run /cheapag:allow here for ${providerLabel(target)}`);
    } else {
      // what the user is agreeing to now: the new recipients and their retention, as /cheapag:allow would show them
      const gate = consentGate(root, target);
      const shown = "block" in gate ? gate.block.split("\n").filter((l) => /^(send|retention):/.test(l)) : [];
      writeConsent(root, { mode: consent.mode, provider: target, approvedAt: new Date().toISOString() });
      out(`✓ ${basename(root)}: consent moved to ${providerLabel(target)} (${describe(consent)}); it now covers:`);
      for (const line of shown) out(`  ${line}`);
    }
  }

  const check = await liveCheck({ provider: target, via: target === "local" ? "config" : "login" } as Provider);
  if (!check.ok) {
    rollBack();
    out(`✗ ${check.line}`);
    const hint = regionHint(check.line);
    if (hint) out(hint);
    out(`Still using ${current ? providerLabel(current) : "no provider"}; nothing changed`);
    return 1;
  }
  out(`✓ ${check.line}`);
  out(`✓ Now using ${providerLabel(target)}; the next job runs on it`);
  return 0;
}
