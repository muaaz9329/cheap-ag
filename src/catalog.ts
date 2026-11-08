import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { userConfigFile } from "./config.js";
import type { Provider } from "./credentials.js";
import { ensureOpencode } from "./opencode.js";

/** A model the provider offers, as OpenCode lists it: prices in USD per million tokens, `efforts` = its variants. */
export type CatalogModel = { id: string; name: string; input: number; output: number; context: number; efforts: string[] };

/** The provider's tool-calling models from the bundled OpenCode's own catalog, cheapest input price first. */
export async function catalog(provider: Provider, cwd: string): Promise<CatalogModel[]> {
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
