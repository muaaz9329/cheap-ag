/**
 * Credentials come only from saved logins in OpenCode's store, written by `cheapag login` (ADR-0004). The local
 * server needs none: it counts as set up once the user config names it, and OpenCode reads its key file, if any.
 */
/** Providers in detection order; `label` is what `cheapag login` shows. */
export declare const PROVIDERS: readonly [{
    readonly id: "opencode-go";
    readonly label: "OpenCode Go";
}, {
    readonly id: "openrouter";
    readonly label: "OpenRouter";
}, {
    readonly id: "deepseek";
    readonly label: "DeepSeek";
}, {
    readonly id: "ollama";
    readonly label: "Ollama";
}, {
    readonly id: "commandcode";
    readonly label: "Command Code";
}, {
    readonly id: "opencode";
    readonly label: "OpenCode Zen";
}, {
    readonly id: "local";
    readonly label: "Custom endpoint";
}];
export type Provider = {
    provider: (typeof PROVIDERS)[number]["id"];
    via: "login" | "config";
};
export declare const LOGIN_COMMAND = "npx cheap-agent login";
export declare const NO_PROVIDER = "FAIL reason: no worker provider; run npx cheap-agent login";
/** Supported providers with a saved login, in detection order. Only the provider ids are used; keys are never kept or passed on. */
export declare function savedProviders(): Provider["provider"][];
/** Whether the user config names a usable local server; a damaged one counts as none here, loadConfig reports it. */
export declare function localConfigured(): boolean;
/** Whether Ollama is set up: its `ollama` config block, or OLLAMA_API_KEY alone (an implicit cloud opt-in); a damaged entry counts as none here. */
export declare function ollamaConfigured(): boolean;
export declare const providerLabel: (id: Provider["provider"]) => "Command Code" | "Custom endpoint" | "DeepSeek" | "Ollama" | "OpenCode Go" | "OpenCode Zen" | "OpenRouter";
/** Supported providers ready to use: saved logins, plus the config-based endpoints when the user set them up; in detection order. */
export declare function usableProviders(): Provider["provider"][];
/**
 * The provider the worker uses: the one `cheapag provider` picked, while it is still set up; else Ollama (set up on
 * purpose, or OLLAMA_API_KEY set), else a configured custom endpoint, else the first saved login.
 */
export declare function detectProvider(): Provider | undefined;
/** Strips key-shaped strings (OpenRouter's sk-or-v1-…, DeepSeek/OpenAI-style sk-…, Cheaper Inference's ci_live_…) from anything that leaves the process. */
export declare function redact(text: string): string;
