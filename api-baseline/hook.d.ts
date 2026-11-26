/**
 * `cheapag hook [on|off]`: the user-only `/cheapag:hook` toggles the edit guard for the current repo; no argument
 * shows its state. `cheapag hook guard` is the plugin's PreToolUse hook (spec E6); `cheapag hook result` its PostToolUse
 * hook on cheapag's own tools, which starts the take-over budget (ticket 29).
 */
export declare function hook(args: string[]): number | Promise<number>;
/**
 * The plugin's SessionStart hook: one line pointing at delegate. The rules live in the server instructions only, since
 * this context lands after Claude Code's cache breakpoint and is rewritten every session (ticket 24.2).
 */
export declare const SESSION_CONTEXT = "Cheap Agent is connected: send every code change to its delegate tool (task: \"<what to change, which files, how to check>\"); its server instructions have the rules.";
