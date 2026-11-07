import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog, saveModels, type CatalogModel, type Pick } from "./catalog.js";
import { loadConfig, userConfigFile } from "./config.js";
import { acceptRoute } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact, type Provider } from "./credentials.js";
import { stopOpencode } from "./opencode.js";
import { select } from "./prompt.js";
import { effectiveModels, fullRoute, PRESETS, ROLES, type WorkerModel } from "./routing.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag model [--list | --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]]";
export const MORE_MODELS = "For more models, exit Claude/Codex and run: npx cheap-agent model";
const SHOWN = 4;

const effort = (e?: string) => `effort ${e ?? "default"}`;
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");

/** `cheapag model`: choose the worker's main and fallback models, each with an effort, from the provider's own catalog. */
export async function model(args: string[]): Promise<number> {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  const flags = parse(args);
  if (typeof flags === "string") return out(`✗ ${flags}\n${USAGE}`), 1;
  const provider = detectProvider();
  if (!provider) return out(`✗ no worker provider; run ${LOGIN_COMMAND} first`), 1;
  process.on("exit", () => stopOpencode(true));
  const dir = mkdtempSync(join(tmpdir(), "cheapag-model-"));
  try {
    const models = await catalog(provider, dir);
    const current = currentRoute(provider);
    if (flags.main !== undefined) return save(provider, models, flags as Required<Pick2>, out);
    if (!flags.list && process.stdin.isTTY) return await pick(provider, models, current, out);
    out(describe(provider, models, current));
    if (!flags.list) out(USAGE);
    return 0;
  } catch (err) {
    out(`✗ ${(err as Error).message}`);
    return 1;
  } finally {
    stopOpencode();
    rmSync(dir, { recursive: true, force: true });
  }
}

type Pick2 = { list: boolean; main?: string; effort?: string; fallback?: string; fallbackEffort?: string };

function parse(args: string[]): Pick2 | string {
  const flags: Pick2 = { list: false };
  const keys: Record<string, "main" | "effort" | "fallback" | "fallbackEffort"> = { "--main": "main", "--effort": "effort", "--fallback": "fallback", "--fallback-effort": "fallbackEffort" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list") flags.list = true;
    else if (keys[args[i]] && args[i + 1] !== undefined) flags[keys[args[i]]] = args[++i];
    else return `unknown or incomplete argument ${args[i]}`;
  }
  if (flags.main === undefined && (flags.effort || flags.fallback || flags.fallbackEffort)) return "--effort, --fallback and --fallback-effort need --main";
  return flags;
}

/** The main and first fallback model the config routes to now (the repo's cheapag.json too, inside one). */
function currentRoute(provider: Provider) {
  let root = process.cwd();
  try {
    root = projectRoot(root);
  } catch {} // outside a repo only the user's config applies
  const route = fullRoute(provider.provider, effectiveModels(provider.provider, loadConfig(root)));
  return { main: route.implement, fallback: route.fallbacks[0] as WorkerModel | undefined };
}

const bare = (provider: Provider, id: string) => (id.startsWith(`${provider.provider}/`) ? id.slice(provider.provider.length + 1) : id);
const line = (m: CatalogModel) => `${m.id} · $${m.input}/$${m.output} per M · ${Math.round(m.context / 1000)}K ctx · efforts: ${list(m.efforts)}`;

/** The 4 models worth showing first: the current main, the preset's balanced pick, then the cheapest (the catalog is cheapest first). */
function suggestions(provider: Provider, models: CatalogModel[], main: WorkerModel) {
  // the current model, then the ones we route and bench (presets, role defaults), then the cheapest paid ones: free
  // catalog entries are often short-lived promos, so they stay in the full picker only
  const presets = Object.values((PRESETS as Record<string, typeof PRESETS["opencode-go"]>)[provider.provider] ?? {}).map((p) => p.implement && bare(provider, p.implement));
  const roles = (ROLES as Record<string, (typeof ROLES)["opencode-go"]>)[provider.provider];
  const ours = [main.id, ...presets, ...(roles ? [...roles.implement, roles.escalation] : [])].map((id) => models.find((m) => m.id === id));
  const paid = models.filter((m) => m.input > 0 || m.output > 0);
  return [...new Set([...ours, ...paid].filter((m): m is CatalogModel => !!m))].slice(0, SHOWN);
}

function describe(provider: Provider, models: CatalogModel[], current: ReturnType<typeof currentRoute>) {
  const { main, fallback } = current;
  return [
    `Provider: ${providerLabel(provider.provider)}`,
    `Main: ${main.id} (${effort(main.variant)})`,
    `Fallback: ${fallback?.id ?? "none"} (${effort(fallback?.variant)})`,
    "Suggestions:",
    ...suggestions(provider, models, main).map(line),
    MORE_MODELS,
  ].join("\n");
}

function save(provider: Provider, models: CatalogModel[], flags: Required<Pick2>, out: (l: string) => void) {
  const label = providerLabel(provider.provider);
  const check = (id: string, wanted?: string) => {
    const found = models.find((m) => m.id === bare(provider, id));
    if (!found) return out(`✗ ${id} is not a tool-calling model on ${label}; run npx cheap-agent model --list`), undefined;
    if (wanted !== undefined && !found.efforts.includes(wanted)) return out(`✗ ${id} has no effort ${wanted}; it has: ${list(found.efforts)}`), undefined;
    return found;
  };
  const none = flags.fallback === undefined || flags.fallback === "none";
  if (none && flags.fallbackEffort !== undefined) return out("✗ --fallback-effort needs --fallback <id>"), 1;
  const main = check(flags.main, flags.effort);
  const fallback = none ? null : check(flags.fallback, flags.fallbackEffort);
  if (!main || fallback === undefined) return 1;
  return apply(provider, { main: main.id, mainEffort: flags.effort, fallback: fallback?.id ?? null, fallbackEffort: flags.fallbackEffort }, out);
}

function apply(provider: Provider, chosen: Pick, out: (l: string) => void) {
  saveModels(provider, chosen);
  // on OpenRouter the model decides the upstream company: picking it is the consent for this repo
  if (provider.provider === "openrouter") {
    try {
      acceptRoute(projectRoot(process.cwd()));
    } catch {} // not inside a repo: no consent to update
  }
  const name = (id: string) => `${provider.provider}/${id}`;
  const second = chosen.fallback ? `${name(chosen.fallback)} (${effort(chosen.fallbackEffort)})` : "none";
  out(`✓ main ${name(chosen.main)} (${effort(chosen.mainEffort)}), fallback ${second} — saved in ${userConfigFile()}; the next job uses it`);
  return 0;
}

/** Effort, when the model has any: `default` first. */
async function askEffort(who: string, m: CatalogModel, now?: string) {
  if (!m.efforts.length) return undefined;
  const i = await select(`Effort for ${who} ${m.id}:`, [{ label: "default" }, ...m.efforts.map((label) => ({ label }))], m.efforts.indexOf(now ?? "") + 1);
  return i ? m.efforts[i - 1] : undefined;
}

async function pick(provider: Provider, models: CatalogModel[], current: ReturnType<typeof currentRoute>, out: (l: string) => void) {
  const row = (m: CatalogModel) => ({ label: m.id, hint: `$${m.input}/$${m.output} per M · ${Math.round(m.context / 1000)}K ctx · efforts: ${list(m.efforts)}` });
  const main = models[await select(`Main model on ${providerLabel(provider.provider)} (writes the code):`, models.map(row), Math.max(0, models.findIndex((m) => m.id === current.main.id)))];
  const mainEffort = await askEffort("main", main, current.main.variant);
  const f = await select("Fallback model (used on a rate limit):", [{ label: "none" }, ...models.map(row)], 0);
  const fallback = f ? models[f - 1] : undefined;
  const fallbackEffort = fallback && (await askEffort("fallback", fallback));
  return apply(provider, { main: main.id, mainEffort, fallback: fallback?.id ?? null, fallbackEffort }, out);
}
