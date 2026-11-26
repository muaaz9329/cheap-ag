/**
 * `cheapag allow`: the developer's opt-in for the current repo (spec: Consent). Non-interactive, so the plugin's
 * user-only `/cheapag:allow` can wrap it. No MCP tool calls this. Modes: all models (no flag), zero-retention only,
 * or an explicit model list. The consent is for the provider logged in now; a later switch asks again.
 */
export declare function allow(args: string[]): number;
