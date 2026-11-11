import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ollamaEndpoint, userConfigFile } from "./config.js";
import type { Provider } from "./credentials.js";
import { ensureOpencode } from "./opencode.js";

/** A model the provider offers, as OpenCode lists it: prices in USD per million tokens, `efforts` = its variants. */
export type CatalogModel = { id: string; name: string; input: number; output: number; context: number; efforts: string[] };

/** The provider's tool-calling models from the bundled OpenCode's own catalog, cheapest input price first. */
export async function catalog(provider: Provider, cwd: string): Promise<CatalogModel[]> {
  // Ollama is not in OpenCode's catalog: ask its own API, which is also what `cheapag login` offers
  if (provider.provider === "ollama") {
    const ollama = ollamaEndpoint();
    if (!ollama) throw new Error("no Ollama endpoint configured; run npx cheap-agent login");
    return ollamaModels(ollama.endpoint, ollama.base_url, ollama.api_key_env ? process.env[ollama.api_key_env] : undefined);
  }
  const opencode = await ensureOpencode(provider, cwd);
  const client = createOpencodeClient({
    baseUrl: opencode.url,
    directory: cwd,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${opencode.password}`).toString("base64")}` },
  });
  const res = await client.config.providers({ directory: cwd });
  if (!res.data) throw new Error(`could not read OpenCode's model catalog: ${JSON.stringify(res.error)}`);
  const entry = res.data.providers.find((p) => p.id === provider.provider);
  if (!entry) throw new Error(`OpenCode lists no models for ${provider.provider}`);
  return Object.values(entry.models)
    .filter((m) => m.capabilities.toolcall)
    .map((m) => ({ id: m.id, name: m.name, input: m.cost.input, output: m.cost.output, context: m.limit.context, efforts: Object.keys(m.variants ?? {}) }))
    .sort((a, b) => a.input - b.input);
}

/**
 * A model the Ollama endpoint serves, with the context window its own API reports when it does. Ollama has no prices
 * and no effort levels, so both read zero/empty; the cloud catalog lists ids only.
 */
export async function ollamaModels(endpoint: "local" | "cloud", baseUrl: string, apiKey?: string): Promise<CatalogModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  return endpoint === "cloud" ? cloudModels(base, apiKey) : localModels(base);
}

async function localModels(base: string): Promise<CatalogModel[]> {
  const root = base.replace(/\/v1$/, "");
  let res: Response;
  try {
    res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    throw new Error(`could not reach Ollama at ${root} (${(err as Error).message}); is it running?`);
  }
  if (!res.ok) throw new Error(`Ollama at ${root} answered ${res.status}; is it running?`);
  const { models } = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
  const ids = [...new Set((models ?? []).flatMap((m) => (typeof m.name === "string" ? [m.name] : typeof m.model === "string" ? [m.model] : [])))].sort();
  if (!ids.length) throw new Error(`Ollama at ${root} has no models pulled; run ollama pull <model>, then try again`);
  const contexts = await Promise.all(ids.map((id) => localContext(root, id)));
  return ids.map((id, i) => ({ id, name: id, input: 0, output: 0, context: contexts[i] ?? 0, efforts: [] }));
}

/** A local model's context window from POST /api/show, when Ollama reports one. */
async function localContext(root: string, model: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return undefined;
    const { model_info } = (await res.json()) as { model_info?: Record<string, unknown> };
    const entry = Object.entries(model_info ?? {}).find(([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0);
    return entry ? (entry[1] as number) : undefined;
  } catch {
    return undefined; // context is a hint only: the picker works without it
  }
}

async function cloudModels(base: string, apiKey: string | undefined): Promise<CatalogModel[]> {
  let res: Response;
  try {
    res = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`could not reach Ollama Cloud at ${base} (${(err as Error).message}); is this machine online?`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Ollama Cloud rejected the key (${res.status}); check OLLAMA_API_KEY`);
  if (!res.ok) throw new Error(`Ollama Cloud answered ${res.status}`);
  const { data } = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  if (!ids.length) throw new Error("Ollama Cloud listed no models");
  return ids.map((id) => ({ id, name: id, input: 0, output: 0, context: 0, efforts: [] }));
}

/** What a pick sets: bare catalog ids; `fallback: null` (or none) leaves no fallback model. */
export type Pick = { main: string; mainEffort?: string; fallback?: string | null; fallbackEffort?: string };

/** Writes the pick into the user config (other keys kept), replacing any preset and any earlier efforts. */
export function saveModels(provider: Provider, pick: Pick) {
  const file = userConfigFile();
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const name = (id: string) => `${provider.provider}/${id}`;
  const { fallback: _old, variants: _variants, ...models } = config.models ?? {};
  const efforts = [[pick.main, pick.mainEffort], [pick.fallback, pick.fallbackEffort]] as const;
  const variants = Object.fromEntries(efforts.filter((e): e is readonly [string, string] => !!e[0] && !!e[1]).map(([id, e]) => [name(id), e]));
  const { preset: _preset, ...rest } = config;
  const next = {
    ...rest,
    // research follows main; "none" is an empty list, so the provider's default fallbacks do not come back
    models: { ...models, implement: name(pick.main), research: name(pick.main), fallback: pick.fallback ? [name(pick.fallback)] : [], ...(Object.keys(variants).length && { variants }) },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}
