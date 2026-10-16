import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag hook [on | off]";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
// the plugin's server and a `cheapag login` registration give the tool different prefixes, so name both
const REDIRECT = "write a plan step and use the cheapag server's delegate tool (mcp__plugin_cheapag_cheapag__delegate, or mcp__cheapag__delegate) instead.";

/** Presence of this file under `.cheapag/` turns the guard on for the repo; it ships off (spec A6). */
const flag = (root: string) => join(root, ".cheapag", "hook.json");

/**
 * `cheapag hook [on|off]`: the user-only `/cheapag:hook` toggles the edit guard for the current repo; no argument
 * shows its state. `cheapag hook guard` is the plugin's PreToolUse hook (spec E6).
 */
export function hook(args: string[]): number {
  if (args.length === 1 && args[0] === "guard") return guard();
  const out = (line: string) => process.stdout.write(line + "\n");
  if (args.length > 1 || (args.length && args[0] !== "on" && args[0] !== "off")) {
    out(`✗ ${USAGE}`);
    return 1;
  }
  let root: string;
  try {
    root = projectRoot(process.cwd());
  } catch (err) {
    out(`✗ ${(err as Error).message}`);
    return 1;
  }
  if (args[0] === "on") {
    mkdirSync(join(root, ".cheapag"), { recursive: true });
    writeFileSync(flag(root), JSON.stringify({ on: true }) + "\n");
  } else if (args[0] === "off") rmSync(flag(root), { force: true });
  let lines: number | string;
  try {
    lines = loadConfig(root).guard_lines;
  } catch (err) {
    lines = `? (${(err as Error).message})`;
  }
  out(existsSync(flag(root))
    ? `✓ edit guard on for ${root}: an edit over ${lines} changed lines, or a 3rd edit to one file in a turn, is denied with a pointer to delegate. CHEAPAG_ALLOW_EDITS=1 bypasses it.`
    : `✓ edit guard off for ${root}: Claude's edits are not limited.`);
  return 0;
}

/**
 * Reads Claude Code's PreToolUse JSON on stdin; prints a deny decision or nothing (no decision: the normal permission
 * flow applies, so the guard never approves anything). Any error allows: a broken guard must never block editing.
 */
function guard(): number {
  try {
    const reason = check(JSON.parse(readFileSync(0, "utf8")));
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
  } catch {
    // allow
  }
  return 0;
}

type Input = { session_id?: string; prompt_id?: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> };

function check(input: Input): string | undefined {
  if (process.env.CHEAPAG_ALLOW_EDITS === "1" || !EDIT_TOOLS.has(input.tool_name ?? "")) return;
  const tool = input.tool_input ?? {};
  if (typeof tool.file_path !== "string" || typeof input.cwd !== "string") return;
  const root = projectRoot(input.cwd);
  if (!existsSync(flag(root))) return;
  const file = resolve(input.cwd, tool.file_path);
  const limit = loadConfig(root).guard_lines;
  const lines = changed(input.tool_name!, tool, file);
  if (lines > limit) return `Large edit (${lines} changed lines, over ${limit}): ${REDIRECT}`;
  // A turn is one user prompt: Claude Code's prompt_id. Without it (older Claude Code) only the size rule applies.
  if (!input.prompt_id || !input.session_id) return;
  // shortcut: one small file per session, never pruned and not locked against parallel edits; prune in `cheapag clean` if they pile up
  const state = join(root, ".cheapag", "hook", `${input.session_id.replace(/[^\w-]/g, "_")}.json`);
  let turn: { prompt: string; edits: Record<string, number> } = { prompt: input.prompt_id, edits: {} };
  try {
    const saved = JSON.parse(readFileSync(state, "utf8"));
    if (saved.prompt === input.prompt_id) turn = saved;
  } catch {
    // first edit of the session
  }
  if ((turn.edits[file] ?? 0) >= 2) return `3rd edit to ${tool.file_path} this turn: ${REDIRECT}`;
  turn.edits[file] = (turn.edits[file] ?? 0) + 1;
  mkdirSync(join(root, ".cheapag", "hook"), { recursive: true });
  writeFileSync(state, JSON.stringify(turn));
}

/** Changed lines of an edit: the larger side once the lines both sides share at the start and end are dropped. */
function changed(name: string, tool: Record<string, unknown>, file: string) {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  // shortcut: replace_all counts one occurrence; count matches in the file if guarded edits slip through that way
  if (name === "Edit") return diff(text(tool.old_string), text(tool.new_string));
  if (name === "MultiEdit") return (Array.isArray(tool.edits) ? tool.edits : []).reduce((n: number, e) => n + diff(text(e?.old_string), text(e?.new_string)), 0);
  return diff(existsSync(file) ? readFileSync(file, "utf8") : "", text(tool.content));
}

function diff(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length - start - end, b.length - start - end);
}
