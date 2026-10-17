import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { projectRoot } from "./workspace.js";
import { VERIFY_RULE } from "./rules.js";

const USAGE = "usage: cheapag hook [on | off]";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Bash"]);
// Bash forms that write a file: redirects and heredocs into a path, in-place sed/perl, tee, cp/mv targets, and
// python/node one-liners that open files for writing. The benchmark showed Claude writing whole files this way.
const BASH_WRITES = [
  /(?:^|[^<>])>{1,2}\s*(?!&)["']?(?<path>[^\s"'|;&]+)/g,
  /\btee\s+(?:-a\s+)?["']?(?<path>[^\s"'|;&]+)/g,
  /\b(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+["']?(?<path>[^\s"'|;&]+)/g,
];
// in-place edits name their files after the script, so they are denied as a whole (plan files are never edited this way)
const BASH_INPLACE = /\b(?:sed|perl)\s+(?:-[a-zA-Z]*i|--in-place)\b/;
const BASH_CODE_WRITES = /\b(?:python3?|node)\s+-[ce]\b[\s\S]*(?:open\([^)]*["'][wa]|writeFile|writeFileSync|\.write_text)/;
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
  if (args.length === 1 && args[0] === "context") return context();
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
    ? `✓ edit guard on for ${root}: an edit over ${lines} changed lines, a 3rd edit to one file in a turn, or a Bash command writing a file is denied with a pointer to delegate (.plan/ is exempt). CHEAPAG_ALLOW_EDITS=1 bypasses it.`
    : `✓ edit guard off for ${root}: Claude's edits are not limited.`);
  return 0;
}

/**
 * The plugin's SessionStart hook: puts the delegation rule into the session's own context, where it weighs more than
 * the MCP server's instructions (benchmark run 2: Claude saw those and still wrote code itself, "small mechanical change").
 */
export const SESSION_CONTEXT = `Cheap Agent is connected in this session. Its cheap worker model writes code so the user's Claude tokens aren't spent on it. For every code change you make here, including small, mechanical, "quick" or multi-file ones, call the cheapag delegate tool with task: "<what to change, which files, how to check>" instead of editing files yourself (Edit/Write, or Bash heredocs, redirects, sed -i). Then read its result block: OK means it already passed its checks and landed, so don't re-run tests or re-read the diff unless risks: says so or the user asks. Only edit directly when the user asks you to, or to fix one line after a worker result. ${VERIFY_RULE}`;

function context(): number {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SESSION_CONTEXT } }) + "\n");
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
  if (typeof input.cwd !== "string") return;
  if (input.tool_name === "Bash") return typeof tool.command === "string" ? bashCheck(input.cwd, tool.command) : undefined;
  if (typeof tool.file_path !== "string") return;
  const root = projectRoot(input.cwd);
  if (!existsSync(flag(root))) return;
  const file = resolve(input.cwd, tool.file_path);
  if (isPlan(root, file)) return; // Claude must be able to write plans of any size
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

/** Plans live in .plan/ and are how Claude delegates, so the guard never blocks them. */
const isPlan = (root: string, file: string) => file.startsWith(join(root, ".plan") + "/");

/** A Bash command is denied when it writes a file inside the repo (any size: the lines can't be counted), unless the file is a plan. */
function bashCheck(cwd: string, command: string): string | undefined {
  const root = projectRoot(cwd);
  if (!existsSync(flag(root))) return;
  const targets: string[] = [];
  for (const re of BASH_WRITES) for (const m of command.matchAll(re)) if (m.groups?.path) targets.push(m.groups.path);
  const inRepo = (p: string) => { const abs = resolve(cwd, p); return abs.startsWith(root + "/") && !isPlan(root, abs); };
  const written = targets.filter((p) => p !== "/dev/null" && inRepo(p));
  if (written.length) return `Bash writing ${written[0]}: ${REDIRECT}`;
  if (BASH_INPLACE.test(command)) return `Bash in-place edit (sed/perl -i): ${REDIRECT}`;
  if (BASH_CODE_WRITES.test(command)) return `Bash running code that writes files: ${REDIRECT}`;
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
