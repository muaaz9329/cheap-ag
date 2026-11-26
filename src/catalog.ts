import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ollamaEndpoint, userConfigFile } from "./config.js";
import type { Provider } from "./credentials.js";
import { authHeaders, ensureOpencode } from "./opencode.js";

/** A model the provider offers, as OpenCode lists it: prices in USD per million tokens, `efforts` = its variants. */
export type CatalogModel = {
  id: string;
  name: string;
  input: number;
  output: number;
  context: number;
  efforts: string[];
};

/** The provider's tool-calling models from the bundled OpenCode's own catalog, cheapest input price first. */
export async function catalog(provider: Provider, cwd: string): Promise<CatalogModel[]> {
  // Ollama is not in OpenCode's catalog: ask its own API, which is also what `cheapag login` offers
  if (provider.provider === "ollama") return configuredOllamaModels();
  const entry = await opencodeCatalogEntry(provider, cwd);
  return Object.values(entry.models)
    .filter((model) => model.capabilities.toolcall)
    .map((model) => ({
      id: model.id,
      name: model.name,
      input: model.cost.input,
      output: model.cost.output,
      context: model.limit.context,
      efforts: Object.keys(model.variants ?? {}),
    }))
    .sort((left, right) => left.input - right.input);
}

/** The provider's entry in the catalog of the OpenCode server for this dir, started if needed. */
async function opencodeCatalogEntry(provider: Provider, cwd: string) {
  const opencode = await ensureOpencode(provider, cwd);
  const client = createOpencodeClient({
    baseUrl: opencode.url,
    directory: cwd,
    headers: authHeaders(opencode.password),
  });
  const response = await client.config.providers({ directory: cwd });
  if (!response.data)
    throw new Error(`could not read OpenCode's model catalog: ${JSON.stringify(response.error)}`);
  const entry = response.data.providers.find((listed) => listed.id === provider.provider);
  if (!entry) throw new Error(`OpenCode lists no models for ${provider.provider}`);
  return entry;
}

/** The models of the Ollama endpoint the user config sets up, with the key from the env variable it names. */
async function configuredOllamaModels(): Promise<CatalogModel[]> {
  const ollama = ollamaEndpoint();
  if (!ollama) throw new Error("no Ollama endpoint configured; run npx cheap-agent login");
  const apiKey = ollama.api_key_env ? process.env[ollama.api_key_env] : undefined;
  return ollamaModels(ollama.endpoint, ollama.base_url, apiKey);
}

/**
 * A model the Ollama endpoint serves, with the context window its own API reports when it does. Ollama has no prices
 * and no effort levels, so both read zero/empty; the cloud catalog lists ids only.
 */
export async function ollamaModels(
  endpoint: "local" | "cloud",
  baseUrl: string,
  apiKey?: string,
): Promise<CatalogModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  return endpoint === "cloud" ? cloudModels(base, apiKey) : localModels(base);
}

async function localModels(base: string): Promise<CatalogModel[]> {
  const root = base.replace(/\/v1$/, "");
  let response: Response;
  try {
    response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      `could not reach Ollama at ${root} (${(error as Error).message}); is it running?`,
    );
  }
  if (!response.ok)
    throw new Error(`Ollama at ${root} answered ${response.status}; is it running?`);
  const { models } = (await response.json()) as { models?: PulledModel[] };
  const ids = [...new Set((models ?? []).flatMap(pulledModelId))].sort();
  if (!ids.length)
    throw new Error(
      `Ollama at ${root} has no models pulled; run ollama pull <model>, then try again`,
    );
  const contexts = await Promise.all(ids.map((id) => localContext(root, id)));
  return ids.map((id, index) => ({
    id,
    name: id,
    input: 0,
    output: 0,
    context: contexts[index] ?? 0,
    efforts: [],
  }));
}

/** One entry of GET /api/tags, unchecked. */
type PulledModel = { name?: unknown; model?: unknown };

/** The entry's name, else its model; an empty list when it has neither, so flatMap skips it. */
function pulledModelId(entry: PulledModel): string[] {
  if (typeof entry.name === "string") return [entry.name];
  if (typeof entry.model === "string") return [entry.model];
  return [];
}

/** A local model's context window from POST /api/show, when Ollama reports one. */
async function localContext(root: string, model: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const { model_info } = (await response.json()) as { model_info?: Record<string, unknown> };
    const entry = Object.entries(model_info ?? {}).find(
      ([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0,
    );
    return entry ? (entry[1] as number) : undefined;
  } catch {
    return undefined; // context is a hint only: the picker works without it
  }
}

async function cloudModels(base: string, apiKey: string | undefined): Promise<CatalogModel[]> {
  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `could not reach Ollama Cloud at ${base} (${(error as Error).message}); is this machine online?`,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(`Ollama Cloud rejected the key (${response.status}); check OLLAMA_API_KEY`);
  if (!response.ok) throw new Error(`Ollama Cloud answered ${response.status}`);
  const { data } = (await response.json()) as { data?: { id?: unknown }[] };
  const ids = (data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : []));
  if (!ids.length) throw new Error("Ollama Cloud listed no models");
  return ids.map((id) => ({ id, name: id, input: 0, output: 0, context: 0, efforts: [] }));
}

/** What a pick sets: bare catalog ids; `fallback: null` (or none) leaves no fallback model. */
export type Pick = {
  main: string;
  mainEffort?: string;
  fallback?: string | null;
  fallbackEffort?: string;
};

/** Writes the pick into the user config (other keys kept), replacing any preset and any earlier efforts. */
export function saveModels(provider: Provider, pick: Pick) {
  const file = userConfigFile();
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const name = (id: string) => `${provider.provider}/${id}`;
  const { fallback: _fallback, variants: _variants, ...models } = config.models ?? {};
  const efforts = [
    [pick.main, pick.mainEffort],
    [pick.fallback, pick.fallbackEffort],
  ] as const;
  const variants = Object.fromEntries(
    efforts
      .filter((pair): pair is readonly [string, string] => !!pair[0] && !!pair[1])
      .map(([id, effort]) => [name(id), effort]),
  );
  const { preset: _preset, ...rest } = config;
  const next = {
    ...rest,
    // research follows main; "none" is an empty list, so the provider's default fallbacks do not come back
    models: {
      ...models,
      implement: name(pick.main),
      research: name(pick.main),
      fallback: pick.fallback ? [name(pick.fallback)] : [],
      ...(Object.keys(variants).length && { variants }),
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}
