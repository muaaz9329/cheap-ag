import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog, saveModels, type CatalogModel, type Pick } from "./catalog.js";
import { loadConfig, userConfigFile } from "./config.js";
import { acceptRoute, modelWarnings } from "./consent.js";
import {
  detectProvider,
  LOGIN_COMMAND,
  providerLabel,
  redact,
  type Provider,
} from "./credentials.js";
import { stopOpencode } from "./opencode.js";
import { select } from "./prompt.js";
import { effectiveModels, fullRoute, PRESETS, ROLES, type WorkerModel } from "./routing.js";
import { projectRoot } from "./workspace.js";

const USAGE =
  "usage: cheapag model [--list | --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]]";
export const MORE_MODELS = "For more models, exit Claude/Codex and run: npx cheap-agent model";
const SHOWN = 4;

function effortText(effort?: string) {
  return `effort ${effort ?? "default"}`;
}

function listText(items: string[]) {
  return items.length ? items.join(", ") : "none";
}

// every line goes through redact, so a key quoted in an error never reaches the terminal
function print(line: string) {
  process.stdout.write(redact(line) + "\n");
}

/** `cheapag model`: choose the worker's main and fallback models, each with an effort, from the provider's own catalog. */
export async function model(args: string[]): Promise<number> {
  const flags = parse(args);
  if (typeof flags === "string") {
    print(`✗ ${flags}\n${USAGE}`);
    return 1;
  }
  const provider = detectProvider();
  if (!provider) {
    print(`✗ no worker provider; run ${LOGIN_COMMAND} first`);
    return 1;
  }
  process.on("exit", () => stopOpencode(true));
  const dir = mkdtempSync(join(tmpdir(), "cheapag-model-"));
  try {
    const models = await catalog(provider, dir);
    const current = currentRoute(provider);
    if (flags.main !== undefined) return saveFlags(provider, models, flags as Required<Flags>);
    if (!flags.list && process.stdin.isTTY) return await pick(provider, models, current);
    print(describe(provider, models, current));
    // a `models` entry naming another provider is ignored when the next job routes
    for (const warning of modelWarnings(provider.provider, repoRoot())) print(`! ${warning}`);
    if (!flags.list) print(USAGE);
    return 0;
  } catch (err) {
    print(`✗ ${(err as Error).message}`);
    return 1;
  } finally {
    stopOpencode();
    rmSync(dir, { recursive: true, force: true });
  }
}

type Flags = {
  list: boolean;
  main?: string;
  effort?: string;
  fallback?: string;
  fallbackEffort?: string;
};

function parse(args: string[]): Flags | string {
  const flags: Flags = { list: false };
  const valueFlags: Record<string, "main" | "effort" | "fallback" | "fallbackEffort"> = {
    "--main": "main",
    "--effort": "effort",
    "--fallback": "fallback",
    "--fallback-effort": "fallbackEffort",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = valueFlags[arg];
    if (arg === "--list") flags.list = true;
    else if (key && args[i + 1] !== undefined) flags[key] = args[++i];
    else return `unknown or incomplete argument ${arg}`;
  }
  if (flags.main === undefined && (flags.effort || flags.fallback || flags.fallbackEffort))
    return "--effort, --fallback and --fallback-effort need --main";
  return flags;
}

/** The repository this run is in, else the cwd (outside one only the user's config applies). */
function repoRoot() {
  try {
    return projectRoot(process.cwd());
  } catch {
    return process.cwd();
  }
}

/** The main and first fallback model the config routes to now (the repo's cheapag.json too, inside one). */
function currentRoute(provider: Provider) {
  const route = fullRoute(
    provider.provider,
    effectiveModels(provider.provider, loadConfig(repoRoot())),
  );
  return { main: route.implement, fallback: route.fallbacks[0] as WorkerModel | undefined };
}

type CurrentRoute = ReturnType<typeof currentRoute>;

/** The id without this provider's prefix, the way the catalog lists it. */
function bareId(provider: Provider, id: string) {
  const prefix = `${provider.provider}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function hasPrice(entry: CatalogModel) {
  return entry.input > 0 || entry.output > 0;
}

// Ollama reports no price and may not report a context window; neither is a zero
function priceText(entry: CatalogModel) {
  return hasPrice(entry) ? `$${entry.input}/$${entry.output} per M` : "no price";
}

function contextText(context: number) {
  return context > 0 ? `${Math.round(context / 1000)}K ctx` : "ctx unknown";
}

/** Price, context window and efforts: the picker's hint, and a suggestion after its id. */
function details(entry: CatalogModel) {
  const efforts = listText(entry.efforts);
  return `${priceText(entry)} · ${contextText(entry.context)} · efforts: ${efforts}`;
}

function suggestionLine(entry: CatalogModel) {
  return `${entry.id} · ${details(entry)}`;
}

/**
 * At most SHOWN models worth showing first: the current main, the ones we route and bench (presets, role
 * defaults), then the cheapest paid ones (the catalog is cheapest first).
 */
function suggestions(provider: Provider, models: CatalogModel[], main: WorkerModel) {
  const presets = (PRESETS as Record<string, (typeof PRESETS)["opencode-go"]>)[provider.provider];
  const presetIds = Object.values(presets ?? {}).map(
    (preset) => preset.implement && bareId(provider, preset.implement),
  );
  const roles = (ROLES as Record<string, (typeof ROLES)["opencode-go"]>)[provider.provider];
  const roleIds = roles ? [...roles.implement, roles.escalation] : [];
  const routed = [main.id, ...presetIds, ...roleIds].map((id) =>
    models.find((entry) => entry.id === id),
  );
  // free catalog entries are often short-lived promos, so they stay in the full picker only
  const paid = models.filter(hasPrice);
  const found = [...routed, ...paid].filter((entry): entry is CatalogModel => !!entry);
  return [...new Set(found)].slice(0, SHOWN);
}

function describe(provider: Provider, models: CatalogModel[], current: CurrentRoute) {
  const { main, fallback } = current;
  return [
    `Provider: ${providerLabel(provider.provider)}`,
    `Main: ${main.id} (${effortText(main.variant)})`,
    `Fallback: ${fallback?.id ?? "none"} (${effortText(fallback?.variant)})`,
    "Suggestions:",
    ...suggestions(provider, models, main).map(suggestionLine),
    MORE_MODELS,
  ].join("\n");
}

function saveFlags(provider: Provider, models: CatalogModel[], flags: Required<Flags>) {
  const label = providerLabel(provider.provider);
  const validModel = (id: string, wanted?: string) => {
    const found = models.find((entry) => entry.id === bareId(provider, id));
    if (!found) {
      print(`✗ ${id} is not a tool-calling model on ${label}; run npx cheap-agent model --list`);
      return undefined;
    }
    if (wanted !== undefined && !found.efforts.includes(wanted)) {
      print(`✗ ${id} has no effort ${wanted}; it has: ${listText(found.efforts)}`);
      return undefined;
    }
    return found;
  };
  const noFallback = flags.fallback === undefined || flags.fallback === "none";
  if (noFallback && flags.fallbackEffort !== undefined) {
    print("✗ --fallback-effort needs --fallback <id>");
    return 1;
  }
  const main = validModel(flags.main, flags.effort);
  // both are checked, so a bad main and a bad fallback are both reported;
  // null means no fallback, undefined a refused one
  const fallback = noFallback ? null : validModel(flags.fallback, flags.fallbackEffort);
  if (!main || fallback === undefined) return 1;
  return savePick(provider, {
    main: main.id,
    mainEffort: flags.effort,
    fallback: fallback?.id ?? null,
    fallbackEffort: flags.fallbackEffort,
  });
}

function savePick(provider: Provider, chosen: Pick) {
  saveModels(provider, chosen);
  // on OpenRouter the model decides the upstream company: picking it is the consent for this repo
  if (provider.provider === "openrouter") {
    try {
      acceptRoute(projectRoot(process.cwd()));
    } catch {} // not inside a repo: no consent to update
  }
  const fullName = (id: string) => `${provider.provider}/${id}`;
  const mainText = `${fullName(chosen.main)} (${effortText(chosen.mainEffort)})`;
  const fallbackText = chosen.fallback
    ? `${fullName(chosen.fallback)} (${effortText(chosen.fallbackEffort)})`
    : "none";
  const file = userConfigFile();
  print(`✓ main ${mainText}, fallback ${fallbackText} — saved in ${file}; the next job uses it`);
  return 0;
}

/** Effort, when the model has any: `default` first. */
async function askEffort(role: string, entry: CatalogModel, currentEffort?: string) {
  if (!entry.efforts.length) return undefined;
  const index = await select(
    `Effort for ${role} ${entry.id}:`,
    [{ label: "default" }, ...entry.efforts.map((label) => ({ label }))],
    entry.efforts.indexOf(currentEffort ?? "") + 1,
  );
  return index ? entry.efforts[index - 1] : undefined;
}

async function pick(provider: Provider, models: CatalogModel[], current: CurrentRoute) {
  const rows = models.map((entry) => ({ label: entry.id, hint: details(entry) }));
  const mainQuestion = `Main model on ${providerLabel(provider.provider)} (writes the code):`;
  const currentIndex = models.findIndex((entry) => entry.id === current.main.id);
  const mainIndex = await select(mainQuestion, rows, Math.max(0, currentIndex));
  const main = models[mainIndex];
  const mainEffort = await askEffort("main", main, current.main.variant);
  const fallbackQuestion = "Fallback model (used on a rate limit):";
  const fallbackIndex = await select(fallbackQuestion, [{ label: "none" }, ...rows], 0);
  const fallback = fallbackIndex ? models[fallbackIndex - 1] : undefined;
  const fallbackEffort = fallback && (await askEffort("fallback", fallback));
  return savePick(provider, {
    main: main.id,
    mainEffort,
    fallback: fallback?.id ?? null,
    fallbackEffort,
  });
}
