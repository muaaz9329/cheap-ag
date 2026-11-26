import { type HardTasks, type TakeOver } from "./config.js";
/**
 * The MCP `instructions` (spec: Server instructions; D12 is the status part): Claude Code loads them at session start,
 * so the usage rules travel with the server and nobody edits CLAUDE.md. Claude Code cuts them at 4,096 characters.
 */
export declare const instructions: (hard?: HardTasks, takeover?: TakeOver, host?: "claude" | "codex") => string;
/**
 * The instructions the server publishes for a host, from this repo's config. Codex has no Sonnet subagent, so hard
 * tasks map to self and a sonnet take-over is self; its ask take-over asks in chat. A missing repo or bad config falls
 * back to the defaults; the two callers (serve and `hook context codex`) must agree, so both go through here.
 */
export declare function hostInstructions(host?: "claude" | "codex", cwd?: string): string;
/** The MCP server over stdio: what Claude Code runs; Codex starts it with `cheap-agent codex`. */
export declare function serve(host?: "claude" | "codex"): Promise<void>;
