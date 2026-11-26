/**
 * `cheapag status` (spec story 112): provider, this repo's consent, running jobs, recent results, and tracked spend
 * against Go's windows. Read-only and non-interactive, so the plugin's `/cheapag:status` can wrap it.
 */
export declare function status(args: string[]): number;
/**
 * This repo's most recent Claude Code session, from its transcript: the context sent on the first turn (its fixed prefix:
 * system prompt, tools, skills, CLAUDE.md), how much of all input came from the prompt cache, and the cache TTL used.
 * Undefined when no transcript is readable.
 */
export declare function lastSession(root: string): {
    prefix: number;
    at: string;
    requests: number;
    hitRate: number;
    ttl?: "5m" | "1h" | "5m+1h";
} | undefined;
