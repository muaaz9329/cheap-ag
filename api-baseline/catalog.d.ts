import type { Provider } from "./credentials.js";
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
export declare function catalog(provider: Provider, cwd: string): Promise<CatalogModel[]>;
/**
 * A model the Ollama endpoint serves, with the context window its own API reports when it does. Ollama has no prices
 * and no effort levels, so both read zero/empty; the cloud catalog lists ids only.
 */
export declare function ollamaModels(endpoint: "local" | "cloud", baseUrl: string, apiKey?: string): Promise<CatalogModel[]>;
/** What a pick sets: bare catalog ids; `fallback: null` (or none) leaves no fallback model. */
export type Pick = {
    main: string;
    mainEffort?: string;
    fallback?: string | null;
    fallbackEffort?: string;
};
/** Writes the pick into the user config (other keys kept), replacing any preset and any earlier efforts. */
export declare function saveModels(provider: Provider, pick: Pick): void;
