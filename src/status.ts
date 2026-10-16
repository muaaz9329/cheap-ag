import { createRequire } from "node:module";
import { describe, readConsent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { records } from "./jobs.js";
import { isAlive, isSupported, UNSUPPORTED_REASON } from "./platform.js";
import { renderJob } from "./report.js";
import { spendWindows } from "./routing.js";
import { projectRoot } from "./workspace.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const RECENT = 5;

/**
 * `cheapag status` (spec story 112): provider, this repo's consent, running jobs, recent results, and tracked spend
 * against Go's windows. Read-only and non-interactive, so the plugin's `/cheapag:status` can wrap it.
 */
export function status(args: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  if (!isSupported()) {
    out(`✗ ${UNSUPPORTED_REASON}`);
    return 1;
  }
  if (args.length) {
    out("✗ usage: cheapag status");
    return 1;
  }
  const provider = detectProvider()?.provider;
  out(`cheapag ${version} provider=${provider ?? `none (run ${LOGIN_COMMAND})`}`);

  let root: string | undefined;
  try {
    root = projectRoot(process.cwd());
  } catch {
    out("repo: not a git repository (no jobs or consent here)");
  }
  if (root) {
    const consent = readConsent(root);
    out(`consent: ${!consent ? "not given; run /cheapag:allow"
      : consent.provider !== provider ? `given for ${providerLabel(consent.provider)}, not the current provider; run /cheapag:allow`
      : `${describe(consent)} (since ${consent.approvedAt.slice(0, 10)})`}`);
    const all = records(root).sort((a, b) => String(b.timing?.startedAt ?? "").localeCompare(String(a.timing?.startedAt ?? "")));
    const inFlight = (r: (typeof all)[number]) => r.status === "RUNNING" || r.status === "BLOCKED";
    const live = all.filter((r) => inFlight(r) && !!r.pid && isAlive(r.pid));
    const rest = all.filter((r) => !live.includes(r));
    const headline = (r: (typeof all)[number]) =>
      `  ${renderJob(r).split("\n")[0]}${inFlight(r) && !live.includes(r) ? " (its server is gone; cancelled at next start)" : ""}`;
    out(live.length ? "running:" : "running: none");
    live.forEach((r) => out(headline(r)));
    out(rest.length ? "recent:" : "recent: none");
    rest.slice(0, RECENT).forEach((r) => out(headline(r)));
    if (rest.length > RECENT) out(`  … +${rest.length - RECENT} older (jobs list)`);
  }

  const spend = spendWindows();
  out(spend.length ? "spend (tracked on this machine, all repos; Go windows where capped):" : "spend: none tracked in the last 30 days");
  for (const { model, windows } of spend) {
    out(`  ${model}  ${windows.map((w) => `${w.window} $${w.spent.toFixed(2)}${w.capUsd ? `/$${w.capUsd.toFixed(2)} (${Math.round((w.spent / w.capUsd) * 100)}%)` : ""}`).join("  ")}`);
  }
  return 0;
}
