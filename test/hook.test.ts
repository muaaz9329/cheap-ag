import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { hermeticHome, serverEntry, tempRepo } from "./harness.js";

/**
 * The edit guard at its own seam (spec: Testing Decisions): the plugin's real hook command, with its npx pin swapped
 * for the built CLI, fed Claude Code PreToolUse JSON on stdin. No stdout = no decision (allowed).
 */
const repoDir = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
const hooks = JSON.parse(readFileSync(join(repoDir, "plugin", "hooks", "hooks.json"), "utf8"));
const command = (hooks.hooks.PreToolUse[0].hooks[0].command as string).replace(`npx -y cheap-agent@${version}`, `"${process.execPath}" "${serverEntry}"`);
const lines = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";

function setup() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const cli = (...args: string[]) => execFileSync(process.execPath, [serverEntry, "hook", ...args], { cwd: repo.dir, env, encoding: "utf8" });
  /** Runs the hook; returns the deny reason, or null when it made no decision. */
  const run = (tool_name: string, tool_input: Record<string, unknown>, opts: { prompt?: string; extraEnv?: Record<string, string>; stdin?: string } = {}) => {
    const input = { session_id: "s1", prompt_id: opts.prompt ?? "p1", cwd: repo.dir, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t" };
    const r = spawnSync("sh", ["-c", command], { cwd: repo.dir, env: { ...env, ...opts.extraEnv }, input: opts.stdin ?? JSON.stringify(input), encoding: "utf8" });
    expect(r.status).toBe(0);
    if (!r.stdout.trim()) return null;
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    return out.permissionDecisionReason as string;
  };
  const edit = (file: string, old_string: string, new_string: string, prompt?: string) => run("Edit", { file_path: file, old_string, new_string }, { prompt });
  return { repo, cli, run, edit, env };
}

test("off by default: even a large write is left to the normal permission flow", () => {
  const { run, cli, repo, env } = setup();
  expect(run("Write", { file_path: "big.ts", content: lines(100) })).toBeNull();
  expect(cli()).toMatch(/edit guard off/);
  // the CLI checks too, without the plugin's shell test in front of it
  const input = { session_id: "s", prompt_id: "p", cwd: repo.dir, tool_name: "Write", tool_input: { file_path: "big.ts", content: lines(100) } };
  expect(execFileSync(process.execPath, [serverEntry, "hook", "guard"], { cwd: repo.dir, env, input: JSON.stringify(input), encoding: "utf8" })).toBe("");
});

test("on: a large edit is denied with a redirect to delegate; small edits pass; the env bypass and off restore editing", () => {
  const { run, edit, cli, repo } = setup();
  expect(cli("on")).toMatch(/edit guard on .*over 20 changed lines/);
  const reason = run("Write", { file_path: "big.ts", content: lines(21) });
  expect(reason).toMatch(/^Large edit \(21 changed lines, over 20\): write a plan step and use the cheapag server's delegate tool/);
  expect(reason).toContain("mcp__plugin_cheapag_cheapag__delegate");
  expect(reason).toContain("mcp__cheapag__delegate");
  expect(run("Write", { file_path: "ok.ts", content: lines(20) })).toBeNull();
  expect(edit("a.ts", lines(25), lines(25, "y"))).toMatch(/Large edit \(25/);
  expect(run("MultiEdit", { file_path: "m.ts", edits: [{ old_string: "a", new_string: lines(11).trimEnd() }, { old_string: "b", new_string: lines(11).trimEnd() }] })).toMatch(/Large edit \(22/);
  // context lines Claude repeats on both sides are not changes
  expect(edit("a.ts", lines(30), lines(30).replace("x15", "changed"))).toBeNull();
  // rewriting an existing file counts only the lines that differ
  writeFileSync(join(repo.dir, "kept.ts"), lines(100));
  expect(run("Write", { file_path: join(repo.dir, "kept.ts"), content: lines(100).replace("x50", "y") })).toBeNull();
  expect(run("Read", { file_path: "big.ts" })).toBeNull();
  expect(run("Write", { file_path: "big.ts", content: lines(100) }, { extraEnv: { CHEAPAG_ALLOW_EDITS: "1" } })).toBeNull();
  // a broken input never blocks
  expect(run("Write", {}, { stdin: "not json" })).toBeNull();
  expect(cli("off")).toMatch(/edit guard off/);
  expect(run("Write", { file_path: "big.ts", content: lines(100) })).toBeNull();
  expect(spawnSync(process.execPath, [serverEntry, "hook", "maybe"], { cwd: repo.dir, encoding: "utf8" }).stdout).toMatch(/usage: cheapag hook \[on \| off\]/);
});

test("on: the 3rd edit to one file in a turn is denied; other files and a new turn start fresh", () => {
  const { edit, cli, repo } = setup();
  cli("on");
  expect(edit("a.ts", "1", "2")).toBeNull();
  expect(edit("./a.ts", "2", "3")).toBeNull();
  expect(edit(join(repo.dir, "a.ts"), "3", "4")).toBe("3rd edit to " + join(repo.dir, "a.ts") + " this turn: write a plan step and use the cheapag server's delegate tool (mcp__plugin_cheapag_cheapag__delegate, or mcp__cheapag__delegate) instead.");
  expect(edit("a.ts", "3", "4")).toMatch(/^3rd edit/);
  expect(edit("b.ts", "1", "2")).toBeNull();
  expect(edit("a.ts", "1", "2", "p2")).toBeNull();
});

test("guard_lines comes from the repo's cheapag.json", () => {
  const { run, cli, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ guard_lines: 5 }));
  expect(cli("on")).toMatch(/over 5 changed lines/);
  expect(run("Write", { file_path: "f.ts", content: lines(5) })).toBeNull();
  expect(run("Write", { file_path: "f.ts", content: lines(6) })).toMatch(/Large edit \(6 changed lines, over 5\)/);
});
