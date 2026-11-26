import { type ModelsConfig, type Preset } from "./routing.js";
/** Optional settings: the repo's `cheapag.json` overrides the user's `~/.config/cheapag/config.json` (spec E4). */
export type Config = {
    test_cmd?: string;
    integration_cmd?: string;
    link_dirs: string[];
    allow_commands: string[];
    limits: Limits;
    retention: Retention;
    models: ModelsConfig;
    preset?: Preset;
    escalation_skip_at: number;
    guard_lines: number;
    hard_tasks: HardTasks;
    takeover: TakeOver;
    on_blocked_command: OnBlockedCommand;
};
/** Whether a command off the allow list pauses the job for the user, or is refused as before (ticket 69). */
export declare const ON_BLOCKED_COMMAND: readonly ["ask", "deny"];
export type OnBlockedCommand = (typeof ON_BLOCKED_COMMAND)[number];
/** Who implements a hard task (ticket 26): the worker on `models.hard`, Claude itself, or Claude's own Sonnet subagent. */
export declare const HARD_TASKS: readonly ["delegate", "self", "sonnet"];
export type HardTasks = (typeof HARD_TASKS)[number];
/** Who finishes a step the worker could not (tickets 30, 51): ask the user, a Sonnet subagent, or Claude itself within limits.takeover_calls. */
export declare const TAKE_OVER: readonly ["sonnet", "self", "ask"];
export type TakeOver = (typeof TAKE_OVER)[number];
/** Per-job caps, counted across the whole job: first run, self-fixes and escalation (spec: Models and limits); `max_parallel` bounds a batch's concurrent groups; `max_blocked_minutes` bounds a wait for `reply`. */
export type Limits = {
    max_turns: number;
    max_minutes: number;
    max_cost_usd: number;
    max_parallel: number;
    max_blocked_minutes: number;
    repro_by_turns: number;
    takeover_calls: number;
};
/** How long cleanup keeps an unlanded worktree and a job folder, in days (spec A20). */
export type Retention = {
    unlanded_worktree_days: number;
    job_log_days: number;
};
/** The user-level config every repo's `cheapag.json` overrides; `cheapag login` writes its `preset`. */
export declare const userConfigFile: () => string;
/**
 * A custom OpenAI-compatible endpoint for the worker: a local server (llama.cpp, Strata, Ollama, LM Studio, vLLM) or a
 * hosted gateway (LiteLLM, Azure, any vendor's OpenAI-compatible API): `local` in the
 * user config only, so a repo's cheapag.json can never point the worker at another endpoint. `model` is the server's
 * model id; `api_key_file` names a file and `api_key_env` an environment variable OpenCode reads the key from (Cheap Agent
 * never reads either); `context` and `output`
 * are the model's token limits, which OpenCode needs to compact a long session before the server rejects it.
 */
export type LocalServer = {
    base_url: string;
    model: string;
    api_key_file?: string;
    api_key_env?: string;
    context?: number;
    output?: number;
    /** USD per million tokens, for spend tracking and the job cost cap; without it a job's cost reads $0. */
    price?: {
        input: number;
        output: number;
    };
};
/**
 * Ollama, one provider id with two endpoints (issue #27): a local server that needs no key, or Ollama Cloud at
 * ollama.com, whose key comes from an environment variable. `model` is the local endpoint's model (there is no
 * catalog to default from); the cloud endpoint uses the provider's role defaults and presets.
 */
export type OllamaConfig = {
    endpoint: "local" | "cloud";
    /** Local endpoint only: the model to run, e.g. "llama3.2". */
    model?: string;
    base_url: string;
    /** Cloud endpoint only: the variable OpenCode reads the key from (default OLLAMA_API_KEY). */
    api_key_env?: string;
    context?: number;
    output?: number;
    price?: {
        input: number;
        output: number;
    };
};
export declare const OLLAMA_KEY_ENV = "OLLAMA_API_KEY";
export declare const OLLAMA_LOCAL_URL: "http://127.0.0.1:11434/v1";
export declare const OLLAMA_CLOUD_URL: "https://ollama.com/v1";
/** Whether a URL's host is this machine or a private network (where plain http is fine): loopback, RFC 1918, CGNAT, link-local, *.local, single-label names and home LAN suffixes. */
export declare function privateHost(url: string): boolean;
/** The provider `cheapag provider` (or a login) picked, from the user config; undefined when none is set or the file is damaged. */
export declare function chosenProvider(): string | undefined;
/** The user config's `local` server, undefined when none is set; throws on a damaged one. */
export declare function localServer(): LocalServer | undefined;
/** The user config's Ollama endpoint, undefined when none is set; throws on a damaged entry. */
export declare function ollamaConfig(): OllamaConfig | undefined;
/**
 * The endpoint the worker uses: the configured `ollama` block, else Ollama Cloud when OLLAMA_API_KEY is set (the key
 * alone is an implicit opt-in). Undefined when neither; a damaged entry throws, as `localServer` does.
 */
export declare function ollamaEndpoint(): OllamaConfig | undefined;
/** Whether the Ollama endpoint is this machine's (nothing leaves it); a damaged entry counts as not local, the config load reports it. */
export declare function ollamaIsLocal(): boolean;
export declare function loadConfig(root: string): Config;
/** "Always allow" (ticket 69): appends `prefix` to `allow_commands` in the repo's cheapag.json, creating the file with only that key; every other key and its order stay. */
export declare function addAllowCommand(root: string, prefix: string): void;
