import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { gitBash } from "../src/platform.js";
import { hermeticHome, serverEntry, slow, tempRepo } from "./harness.js";

/**
 * The edit guard at its own seam (spec: Testing Decisions): the plugin's real hook command, with its npx pin swapped
 * for the built CLI, fed Claude Code PreToolUse JSON on stdin. No stdout = no decision (allowed).
 */
const repoDir = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
const hooks = JSON.parse(readFileSync(join(repoDir, "plugin", "hooks", "hooks.json"), "utf8"));
const command = (hooks.hooks.PreToolUse[0].hooks[0].command as string).replace(`npx -y cheap-agent@${version}`, `"${process.execPath}" "${serverEntry}"`);
const resultCommand = (hooks.hooks.PostToolUse[0].hooks[0].command as string).replace(`npx -y cheap-agent@${version}`, `"${process.execPath}" "${serverEntry}"`);
const lines = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";

function setup() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const cli = (...args: string[]) => execFileSync(process.execPath, [serverEntry, "hook", ...args], { cwd: repo.dir, env, encoding: "utf8" });
  /** Runs the hook; returns the deny reason, or null when it made no decision. */
  const run = (tool_name: string, tool_input: Record<string, unknown>, opts: { prompt?: string; extraEnv?: Record<string, string>; stdin?: string; agent?: string } = {}) => {
    const input = { session_id: "s1", prompt_id: opts.prompt ?? "p1", cwd: repo.dir, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", ...(opts.agent && { agent_id: opts.agent, agent_type: "general-purpose" }) };
    const r = spawnSync(gitBash() ?? "sh", ["-c", command], { cwd: repo.dir, env: { ...env, ...opts.extraEnv }, input: opts.stdin ?? JSON.stringify(input), encoding: "utf8" });
    expect(r.status).toBe(0);
    if (!r.stdout.trim()) return null;
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    return out.permissionDecisionReason as string;
  };
  const edit = (file: string, old_string: string, new_string: string, prompt?: string) => run("Edit", { file_path: file, old_string, new_string }, { prompt });
  /** Feeds the PostToolUse hook a cheapag tool's result, as MCP content blocks. */
  const result = (text: string, prompt = "p1", tool_name = "mcp__plugin_cheapag_cheapag__delegate") => {
    const input = { session_id: "s1", prompt_id: prompt, cwd: repo.dir, hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_response: [{ type: "text", text }], tool_use_id: "t" };
    const r = spawnSync(gitBash() ?? "sh", ["-c", resultCommand], { cwd: repo.dir, env, input: JSON.stringify(input), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  };
  return { repo, cli, run, edit, env, result };
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

test("on: Bash commands that write repo files are denied; reads, tests, /dev/null and .plan/ pass", () => {
  const { run, cli } = setup();
  cli("on");
  const bash = (command: string, extraEnv?: Record<string, string>) => run("Bash", { command }, { extraEnv });
  expect(bash("cat > src/errors.js <<'EOF'\nexport class X {}\nEOF")).toMatch(/^Bash writing src\/errors.js: write a plan step/);
  expect(bash("echo hi >> src/a.js")).toMatch(/Bash writing src\/a.js/);
  expect(bash("sed -i '' '1i\\\nimport x\n' src/inventory.js src/pricing.js")).toMatch(/Bash in-place edit \(sed\/perl -i\)/);
  expect(bash("tee src/b.js <<EOF\nx\nEOF")).toMatch(/Bash writing src\/b.js/);
  expect(bash("cp /tmp/new.js src/new.js")).toMatch(/Bash writing src\/new.js/);
  expect(bash("python3 -c \"open('src/x.js','w').write('1')\"")).toMatch(/Bash running code that writes files/);
  expect(bash("node -e \"require('fs').writeFileSync('src/x.js','1')\"")).toMatch(/Bash running code that writes files/);
  for (const ok of ["grep -rn 'throw new Error' src; ls src", "cat src/a.js | head", "node --test", "npm test 2>&1 | tail -5", "git diff --stat", "npm test > /dev/null 2>&1; echo $?", "cat > .plan/feature.md <<'EOF'\n# plan\nEOF", "mkdir -p .plan && tee .plan/x.md <<EOF\nx\nEOF", "echo x > /tmp/outside.txt", "node -e \"console.log(1)\""]) {
    expect(bash(ok), ok).toBeNull();
  }
  expect(bash("cat > src/errors.js <<'EOF'\nx\nEOF", { CHEAPAG_ALLOW_EDITS: "1" })).toBeNull();
  // plans are exempt from the edit tools too
  expect(run("Write", { file_path: ".plan/big.md", content: lines(60) })).toBeNull();
  expect(run("Write", { file_path: "src/big.js", content: lines(60) })).toMatch(/Large edit/);
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

test("context: the SessionStart hook prints a one-line pointer to delegate; the rules stay in the server instructions", () => {
  const out = JSON.parse(execFileSync(process.execPath, [serverEntry, "hook", "context"], { encoding: "utf8" }));
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("delegate tool");
  expect(out.hookSpecificOutput.additionalContext).toContain('task: "<what to change, which files, how to check>"');
  expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(250); // rewritten every session, after the cache breakpoint
});

const FAIL_BLOCK = "FAIL jab12 step=1 files=0 +0/-0 tests=pass turns=12 cost=$0.003\nfound: django/db/models/query.py:only(), proxy model pk\nreason: no reproduction test by turn 12";
const read = { file_path: "a.ts" };

test("takeover self: after a FAIL, the call past limits.takeover_calls in that prompt is denied; cheapag's tools never count; a new prompt is free", () => {
  const { run, result, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "self", limits: { takeover_calls: 3 } }));
  expect(run("Read", read)).toBeNull(); // no take-over yet: the shell test skips node entirely
  result("OK jab11 step=1 files=1 +1/-1 tests=pass turns=4 cost=$0.002");
  for (let i = 0; i < 5; i++) expect(run("Bash", { command: "ls" })).toBeNull(); // an OK starts no count
  result(FAIL_BLOCK);
  for (let i = 0; i < 3; i++) expect(run(i ? "Bash" : "Read", i ? { command: "ls" } : read)).toBeNull();
  expect(run("mcp__plugin_cheapag_cheapag__land", { job: "jab12" })).toBeNull();
  const reason = run("Read", read);
  expect(reason).toMatch(/^Take-over budget spent \(3 tool calls after a cheapag FAIL or PARTIAL\): stop now and tell the user what is fixed, what is left and the failing test\./);
  expect(reason).toContain("limits.takeover_calls");
  // a second failure in the same prompt does not reset the count
  result(FAIL_BLOCK.replace("jab12", "jab13"));
  expect(run("Bash", { command: "ls" })).toMatch(/^Take-over budget spent/);
  // the user's next prompt ends the take-over
  expect(run("Bash", { command: "ls" }, { prompt: "p2" })).toBeNull();
});

test("takeover self: PARTIAL and TIMEOUT start it too; limits.takeover_calls 0 turns it off", () => {
  const { run, result, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "self", limits: { takeover_calls: 1 } }));
  result("PARTIAL jab14 step=1 files=1 +13/-0 tests=pass turns=25 cost=$0.012\nmissing:\n  - unknown");
  expect(run("Read", read)).toBeNull();
  expect(run("Read", read)).toMatch(/^Take-over budget spent \(1 tool calls/);
  result("TIMEOUT jab15 step=1 files=0 +0/-0 turns=9 cost=$0.01\nreason: minute cap", "p2", "mcp__cheapag__jobs");
  expect(run("Read", read, { prompt: "p2" })).toBeNull();
  expect(run("Read", read, { prompt: "p2" })).toMatch(/^Take-over budget spent/);
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "self", limits: { takeover_calls: 0 } }));
  expect(run("Read", read, { prompt: "p2" })).toBeNull();
});

test("takeover sonnet (default): after a FAIL, only the Agent tool, read-only tools and cheapag's tools are left; the subagent works freely; a new prompt is free", () => {
  const { run, result } = setup();
  result(FAIL_BLOCK);
  const reason = run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" });
  expect(reason).toMatch(/^The worker did not finish this step: hand it to your Agent tool with model: sonnet \(the task, the user's words, the block's found:, test=, error: and worktree\)/);
  expect(reason).toContain('takeover: "self"');
  expect(run("Bash", { command: "./swebench-test.sh x" })).toMatch(/^The worker did not finish/);
  expect(run("mcp__cheapag__land", { job: "jab12" })).toBeNull();
  // reads and read-only Bash are how the reader inspects the diff before handing it over
  expect(run("Read", read)).toBeNull();
  expect(run("Grep", { pattern: "x" })).toBeNull();
  expect(run("Glob", { pattern: "*.ts" })).toBeNull();
  expect(run("LS", { path: "." })).toBeNull();
  expect(run("Bash", { command: "git diff -- src/a.ts" })).toBeNull();
  expect(run("Bash", { command: "cat src/a.ts | head" })).toBeNull();
  // writes and test runs stay denied
  expect(run("Bash", { command: "npm test" })).toMatch(/^The worker did not finish/);
  expect(run("Bash", { command: "echo x > f" })).toMatch(/^The worker did not finish/);
  expect(run("Bash", { command: "cat a && npm test" })).toMatch(/^The worker did not finish/);
  // the hand-off clears the FAIL: once Claude calls the Agent, writing is its own business again
  expect(run("Agent", { model: "sonnet", prompt: "finish it" })).toBeNull();
  expect(run("Bash", { command: "echo x > f" })).toBeNull();
  expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBeNull();
  // the subagent's own calls carry agent_id: never denied, never counted
  for (let i = 0; i < 4; i++) expect(run(i % 2 ? "Edit" : "Bash", i % 2 ? { file_path: "a.ts", old_string: "a", new_string: "b" } : { command: "pytest -q" }, { agent: "ab9d" })).toBeNull();
  expect(run("Read", read, { prompt: "p2" })).toBeNull();
}, slow(20_000));

test("takeover sonnet: cd/env prefixes and git's -C/--no-pager/-c options stay reads; edits outside the repo pass; an env FAIL blocks nothing", () => {
  const { run, result, repo } = setup();
  result(FAIL_BLOCK);
  expect(run("Bash", { command: "cd /repo && git status" })).toBeNull();
  expect(run("Bash", { command: "git -C /repo diff -- a.ts" })).toBeNull();
  expect(run("Bash", { command: "git --no-pager log" })).toBeNull();
  expect(run("Bash", { command: "git -c core.pager=cat status" })).toBeNull();
  expect(run("Bash", { command: "X=1 git log" })).toBeNull();
  // a write or a test still starts it, even behind cd
  expect(run("Bash", { command: "cd /repo && npm test" })).toMatch(/^The worker did not finish/);
  expect(run("Bash", { command: "cd /repo && echo x > f" })).toMatch(/^The worker did not finish/);
  // edits resolve against the repo: inside is denied, outside is not
  expect(run("Write", { file_path: join(repo.dir, "inside.ts"), content: "x" })).toMatch(/^The worker did not finish/);
  expect(run("Write", { file_path: "/tmp/outside.ts", content: "x" })).toBeNull();
  expect(run("NotebookEdit", { notebook_path: "/tmp/n.ipynb" })).toBeNull();
  // an OK the worker applied or discarded clears the earlier FAIL even without a check
  result("OK j1 discarded");
  expect(run("Bash", { command: "npm test" })).toBeNull();
});

test("takeover: an env-kind FAIL leaves the guard off (nothing for the taker to finish)", () => {
  const { run, result } = setup();
  result("FAIL j1 step=1 files=0 +0/-0 tests=fail turns=3 cost=$0.001 check=env\nreason: command not found");
  expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBeNull();
});

test("trust OK: after an OK whose checks passed, re-running tests is denied; other tools pass; tests=none and a new prompt are free; a later FAIL wins", () => {
  const { run, result } = setup();
  result("OK jab21 step=1 files=1 +1/-1 tests=none turns=4 cost=$0.002");
  expect(run("Bash", { command: "npm test" })).toBeNull(); // nothing ran in the worktree: Claude may test
  result("OK jab22 step=1 files=1 +1/-1 tests=pass turns=4 cost=$0.002 repro=unverified");
  for (const command of ["./swebench-test.sh migrations.test_commands", "python -m pytest tests/x.py", "npx vitest run a.test.ts", "cd pkg && go test ./..."]) {
    expect(run("Bash", { command })).toBe("An OK is done: its checks already passed in the worker's worktree, so don't re-run tests. Report the result, or delegate the next step.");
  }
  expect(run("Bash", { command: "git status --short" })).toBeNull();
  expect(run("Read", read)).toBeNull();
  expect(run("Bash", { command: "pytest -q" }, { agent: "ab9d" })).toBeNull(); // a subagent may test
  expect(run("Bash", { command: "npm test" }, { prompt: "p2" })).toBeNull();
  result(FAIL_BLOCK, "p2");
  expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, { prompt: "p2" })).toMatch(/^The worker did not finish/);
}, slow(20_000));
