import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadConfig } from "./config.js";
import { projectRoot } from "./workspace.js";

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
const CHEAPAG_TOOL = /^mcp__(?:plugin_cheapag_)?cheapag__/;
// a job block whose first word means the worker did not finish the step (the server's FAIL/PARTIAL/TIMEOUT)
const NOT_DONE = /^(?:FAIL|PARTIAL|TIMEOUT) j\w+ /m;
// an OK whose checks passed in the worker's worktree (ticket 30: re-running them caught nothing)
const OK_PASSED = /^OK j\w+ step=\S+ .*\btests=pass\b/m;
// shortcut: the usual runners only; add the repo's test_cmd if Claude re-runs tests through a custom script
const TEST_CMD = /swebench-test\.sh|\bpytest\b|runtests\.py|bin\/test\b|\b(?:npm|pnpm|yarn|bun) (?:run )?test\b|node --test|\btox\b|\bvitest\b|\bjest\b|\bgo test\b|\bcargo test\b|\b(?:mvn|gradle|gradlew) test\b|\brspec\b|\bphpunit\b|-m unittest\b|\bmake test\b/;

/** Presence of this file under `.cheapag/` turns the guard on for the repo; it ships off (spec A6). */
const flag = (root: string) => join(root, ".cheapag", "hook.json");

/**
 * `cheapag hook [on|off]`: the user-only `/cheapag:hook` toggles the edit guard for the current repo; no argument
 * shows its state. `cheapag hook guard` is the plugin's PreToolUse hook (spec E6); `cheapag hook result` its PostToolUse
 * hook on cheapag's own tools, which starts the take-over budget (ticket 29).
 */
export function hook(args: string[]): number {
  if (args.length === 1 && args[0] === "guard") return guard();
  if (args.length === 1 && args[0] === "context") return context();
  if (args.length === 1 && args[0] === "result") return result();
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
 * The plugin's SessionStart hook: one line pointing at delegate. The rules live in the server instructions only, since
 * this context lands after Claude Code's cache breakpoint and is rewritten every session (ticket 24.2).
 */
export const SESSION_CONTEXT = `Cheap Agent is connected: send every code change to its delegate tool (task: "<what to change, which files, how to check>"); its server instructions have the rules.`;

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
    const input = JSON.parse(readFileSync(0, "utf8"));
    const reason = budget(input) ?? check(input);
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
  } catch {
    // allow
  }
  return 0;
}

// agent_id is set only on a subagent's calls (seen live on Claude Code 2.1.285); the prompt rules never count or deny them
type Input = { session_id?: string; prompt_id?: string; agent_id?: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
/** What this user prompt's cheapag results were: the worker did not finish a step (and Claude's calls since), or an OK passed its checks. */
type PromptState = { prompt: string; calls: number; notDone?: boolean; okPassed?: boolean };

/** Per-session state; the repo-wide marker lets the plugin's shell test skip node until a cheapag result was ever seen. */
const stateFile = (root: string, session: string) => join(root, ".cheapag", "hook", `${session.replace(/[^\w-]/g, "_")}.takeover.json`);
const marker = (root: string) => join(root, ".cheapag", "hook", "takeover");

/**
 * The prompt rules (tickets 29, 30), for the main loop only:
 * - after a FAIL, PARTIAL or TIMEOUT, takeover "sonnet" leaves only the Agent tool (to hand the step to a Sonnet subagent)
 *   and cheapag's tools; "self" denies the call after limits.takeover_calls (resolved take-overs used at most 13).
 * - after an OK whose checks passed, re-running tests is denied: unverified OKs were as correct as verified ones.
 * A new user prompt clears both. cheapag's own tools and a subagent's calls are never counted or denied.
 */
function budget(input: Input): string | undefined {
  if (!input.session_id || !input.prompt_id || input.agent_id || typeof input.cwd !== "string" || CHEAPAG_TOOL.test(input.tool_name ?? "")) return;
  const root = projectRoot(input.cwd);
  const file = stateFile(root, input.session_id);
  let state: PromptState;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return; // no cheapag result in this session yet
  }
  if (state.prompt !== input.prompt_id) return; // a new user prompt starts fresh
  const config = loadConfig(root);
  if (state.notDone && config.takeover === "sonnet") {
    if (input.tool_name === "Agent" || input.tool_name === "Task") return;
    return `The worker did not finish this step: hand it to your Agent tool with model: sonnet (the task, the user's words, the block's found:, test=, error: and worktree) instead of doing it yourself, then report its answer. The user can set takeover: "self" in cheapag.json.`;
  }
  if (state.notDone) {
    const limit = config.limits.takeover_calls;
    if (!limit) return;
    if (state.calls >= limit) return `Take-over budget spent (${limit} tool calls after a cheapag FAIL or PARTIAL): stop now and tell the user what is fixed, what is left and the failing test. The user can raise limits.takeover_calls in cheapag.json.`;
    writeFileSync(file, JSON.stringify({ ...state, calls: state.calls + 1 }));
    return;
  }
  const command = input.tool_input?.command;
  if (state.okPassed && input.tool_name === "Bash" && typeof command === "string" && TEST_CMD.test(command)) {
    return "An OK is done: its checks already passed in the worker's worktree, so don't re-run tests. Report the result, or delegate the next step.";
  }
}

/** Reads Claude Code's PostToolUse JSON for a cheapag tool and records what its result means for this prompt. Never blocks. */
function result(): number {
  try {
    const input: Input = JSON.parse(readFileSync(0, "utf8"));
    if (!input.session_id || !input.prompt_id || input.agent_id || typeof input.cwd !== "string") return 0;
    const out = text(input.tool_response);
    const notDone = NOT_DONE.test(out), okPassed = OK_PASSED.test(out);
    if (!notDone && !okPassed) return 0;
    const root = projectRoot(input.cwd);
    const file = stateFile(root, input.session_id);
    let state: PromptState = { prompt: input.prompt_id, calls: 0 };
    try {
      const saved: PromptState = JSON.parse(readFileSync(file, "utf8"));
      if (saved.prompt === input.prompt_id) state = saved; // a second failure in the same prompt keeps counting from the first
    } catch {
      // first cheapag result of the session
    }
    mkdirSync(join(root, ".cheapag", "hook"), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...state, ...(notDone && { notDone }), ...(okPassed && { okPassed }) } satisfies PromptState));
    // shortcut: the marker is never removed, so a repo that once had a cheapag result runs node on every tool call (~50 ms); drop it in `cheapag clean` if that shows
    writeFileSync(marker(root), "");
  } catch {
    // never block
  }
  return 0;
}

/** The text of a tool response: a string, MCP content blocks, or an object holding them. */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(text).join("\n");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return typeof o.text === "string" ? o.text : text(o.content ?? "");
  }
  return "";
}

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
const isPlan = (root: string, file: string) => file.startsWith(join(root, ".plan") + sep);

/** A Bash command is denied when it writes a file inside the repo (any size: the lines can't be counted), unless the file is a plan. */
function bashCheck(cwd: string, command: string): string | undefined {
  const root = projectRoot(cwd);
  if (!existsSync(flag(root))) return;
  const targets: string[] = [];
  for (const re of BASH_WRITES) for (const m of command.matchAll(re)) if (m.groups?.path) targets.push(m.groups.path);
  const inRepo = (p: string) => { const abs = resolve(cwd, p); return abs.startsWith(root + sep) && !isPlan(root, abs); };
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
