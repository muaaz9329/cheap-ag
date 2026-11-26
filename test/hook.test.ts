import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { hook, SESSION_CONTEXT } from "../src/hook.js";
import { gitBash } from "../src/platform.js";
import { hostInstructions } from "../src/server.js";
import { hermeticHome, serverEntry, slow, tempRepo } from "./harness.js";

/**
 * The edit guard at its own seam (spec: Testing Decisions): the plugin's real hook command, with its npx pin swapped
 * for the built CLI, fed Claude Code PreToolUse JSON on stdin. No stdout = no decision (allowed).
 */
const repoDir = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
const hooks = JSON.parse(readFileSync(join(repoDir, "plugin", "hooks", "hooks.json"), "utf8"));
const command = (hooks.hooks.PreToolUse[0].hooks[0].command as string).replace(
  `npx -y cheap-agent@${version}`,
  `"${process.execPath}" "${serverEntry}"`,
);
const resultCommand = (hooks.hooks.PostToolUse[0].hooks[0].command as string).replace(
  `npx -y cheap-agent@${version}`,
  `"${process.execPath}" "${serverEntry}"`,
);
const lines = (n: number, tag = "x") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";
/** A Codex apply_patch: sections are `*** Update File:`/`*** Add File:`/`*** Delete File:` with their hunks. */
const applyPatch = (...sections: string[]) =>
  ["*** Begin Patch", ...sections, "*** End Patch"].join("\n") + "\n";
const updateFile = (path: string, removed: number, added: number) =>
  [
    `*** Update File: ${path}`,
    "@@",
    ...Array.from({ length: removed }, (_, i) => `-old${i}`),
    ...Array.from({ length: added }, (_, i) => `+new${i}`),
  ].join("\n");
const addFile = (path: string, added: number) =>
  [`*** Add File: ${path}`, ...Array.from({ length: added }, (_, i) => `+line${i}`)].join("\n");

function setup() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [serverEntry, "hook", ...args], {
      cwd: repo.dir,
      env,
      encoding: "utf8",
    });
  /** Runs the hook; returns the deny reason, or null when it made no decision. */
  const run = (
    tool_name: string,
    tool_input: Record<string, unknown>,
    opts: {
      prompt?: string;
      extraEnv?: Record<string, string>;
      stdin?: string;
      agent?: string;
    } = {},
  ) => {
    const input = {
      session_id: "s1",
      prompt_id: opts.prompt ?? "p1",
      cwd: repo.dir,
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      tool_use_id: "t",
      ...(opts.agent && { agent_id: opts.agent, agent_type: "general-purpose" }),
    };
    const r = spawnSync(gitBash() ?? "sh", ["-c", command], {
      cwd: repo.dir,
      env: { ...env, ...opts.extraEnv },
      input: opts.stdin ?? JSON.stringify(input),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    if (!r.stdout.trim()) return null;
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    return out.permissionDecisionReason as string;
  };
  const edit = (file: string, old_string: string, new_string: string, prompt?: string) =>
    run("Edit", { file_path: file, old_string, new_string }, { prompt });
  /** Feeds the PostToolUse hook a cheapag tool's result, as MCP content blocks. */
  const result = (
    text: string,
    prompt = "p1",
    tool_name = "mcp__plugin_cheapag_cheapag__delegate",
  ) => {
    const input = {
      session_id: "s1",
      prompt_id: prompt,
      cwd: repo.dir,
      hook_event_name: "PostToolUse",
      tool_name,
      tool_input: {},
      tool_response: [{ type: "text", text }],
      tool_use_id: "t",
    };
    const r = spawnSync(gitBash() ?? "sh", ["-c", resultCommand], {
      cwd: repo.dir,
      env,
      input: JSON.stringify(input),
      encoding: "utf8",
    });
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
  const input = {
    session_id: "s",
    prompt_id: "p",
    cwd: repo.dir,
    tool_name: "Write",
    tool_input: { file_path: "big.ts", content: lines(100) },
  };
  expect(
    execFileSync(process.execPath, [serverEntry, "hook", "guard"], {
      cwd: repo.dir,
      env,
      input: JSON.stringify(input),
      encoding: "utf8",
    }),
  ).toBe("");
});

test("on: a large edit is denied with a redirect to delegate; small edits pass; the env bypass and off restore editing", () => {
  const { run, edit, cli, repo } = setup();
  expect(cli("on")).toMatch(/edit guard on .*over 20 changed lines/);
  const reason = run("Write", { file_path: "big.ts", content: lines(21) });
  expect(reason).toMatch(
    /^Large edit \(21 changed lines, over 20\): write a plan step and use the cheapag server's delegate tool/,
  );
  expect(reason).toContain("mcp__plugin_cheapag_cheapag__delegate");
  expect(reason).toContain("mcp__cheapag__delegate");
  expect(run("Write", { file_path: "ok.ts", content: lines(20) })).toBeNull();
  expect(edit("a.ts", lines(25), lines(25, "y"))).toMatch(/Large edit \(25/);
  expect(
    run("MultiEdit", {
      file_path: "m.ts",
      edits: [
        { old_string: "a", new_string: lines(11).trimEnd() },
        { old_string: "b", new_string: lines(11).trimEnd() },
      ],
    }),
  ).toMatch(/Large edit \(22/);
  // context lines Claude repeats on both sides are not changes
  expect(edit("a.ts", lines(30), lines(30).replace("x15", "changed"))).toBeNull();
  // rewriting an existing file counts only the lines that differ
  writeFileSync(join(repo.dir, "kept.ts"), lines(100));
  expect(
    run("Write", { file_path: join(repo.dir, "kept.ts"), content: lines(100).replace("x50", "y") }),
  ).toBeNull();
  expect(run("Read", { file_path: "big.ts" })).toBeNull();
  expect(
    run(
      "Write",
      { file_path: "big.ts", content: lines(100) },
      { extraEnv: { CHEAPAG_ALLOW_EDITS: "1" } },
    ),
  ).toBeNull();
  // a broken input never blocks
  expect(run("Write", {}, { stdin: "not json" })).toBeNull();
  expect(cli("off")).toMatch(/edit guard off/);
  expect(run("Write", { file_path: "big.ts", content: lines(100) })).toBeNull();
  expect(
    spawnSync(process.execPath, [serverEntry, "hook", "maybe"], { cwd: repo.dir, encoding: "utf8" })
      .stdout,
  ).toMatch(/usage: cheapag hook \[on \| off\]/);
});

test("on: Bash commands that write repo files are denied; reads, tests, /dev/null and .plan/ pass", () => {
  const { run, cli } = setup();
  cli("on");
  const bash = (command: string, extraEnv?: Record<string, string>) =>
    run("Bash", { command }, { extraEnv });
  expect(bash("cat > src/errors.js <<'EOF'\nexport class X {}\nEOF")).toMatch(
    /^Bash writing src\/errors.js: write a plan step/,
  );
  expect(bash("echo hi >> src/a.js")).toMatch(/Bash writing src\/a.js/);
  expect(bash("sed -i '' '1i\\\nimport x\n' src/inventory.js src/pricing.js")).toMatch(
    /Bash in-place edit \(sed\/perl -i\)/,
  );
  expect(bash("tee src/b.js <<EOF\nx\nEOF")).toMatch(/Bash writing src\/b.js/);
  expect(bash("cp /tmp/new.js src/new.js")).toMatch(/Bash writing src\/new.js/);
  expect(bash("python3 -c \"open('src/x.js','w').write('1')\"")).toMatch(
    /Bash running code that writes files/,
  );
  expect(bash("node -e \"require('fs').writeFileSync('src/x.js','1')\"")).toMatch(
    /Bash running code that writes files/,
  );
  for (const ok of [
    "grep -rn 'throw new Error' src; ls src",
    "cat src/a.js | head",
    "node --test",
    "npm test 2>&1 | tail -5",
    "git diff --stat",
    "npm test > /dev/null 2>&1; echo $?",
    "cat > .plan/feature.md <<'EOF'\n# plan\nEOF",
    "mkdir -p .plan && tee .plan/x.md <<EOF\nx\nEOF",
    "echo x > /tmp/outside.txt",
    'node -e "console.log(1)"',
  ]) {
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
  expect(edit(join(repo.dir, "a.ts"), "3", "4")).toBe(
    "3rd edit to " +
      join(repo.dir, "a.ts") +
      " this turn: write a plan step and use the cheapag server's delegate tool (mcp__plugin_cheapag_cheapag__delegate, or mcp__cheapag__delegate) instead.",
  );
  expect(edit("a.ts", "3", "4")).toMatch(/^3rd edit/);
  expect(edit("b.ts", "1", "2")).toBeNull();
  expect(edit("a.ts", "1", "2", "p2")).toBeNull();
});

test("guard_lines comes from the repo's cheapag.json", () => {
  const { run, cli, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ guard_lines: 5 }));
  expect(cli("on")).toMatch(/over 5 changed lines/);
  expect(run("Write", { file_path: "f.ts", content: lines(5) })).toBeNull();
  expect(run("Write", { file_path: "f.ts", content: lines(6) })).toMatch(
    /Large edit \(6 changed lines, over 5\)/,
  );
});

test("on: a Codex apply_patch is guarded per file like Edit/Write; garbage is allowed", () => {
  const { run, cli } = setup();
  cli("on");
  const patch = (command: string, prompt?: string) => run("apply_patch", { command }, { prompt });
  // a small patch adds and removes two lines: well under the 20-line limit
  expect(patch(applyPatch(updateFile("src/a.ts", 1, 1)))).toBeNull();
  // a large patch is denied with the same message as an Edit of that size
  expect(patch(applyPatch(addFile("big.ts", 21)))).toMatch(
    /^Large edit \(21 changed lines, over 20\): write a plan step/,
  );
  // a multi-file patch counts each file on its own: 16 + 16 = 32 lines together, but each is under 20
  expect(patch(applyPatch(updateFile("src/a.ts", 8, 8), updateFile("src/b.ts", 8, 8)))).toBeNull();
  // ...and each file's edit is counted for the turn rule: src/a.ts already has 2, so a 3rd is denied
  expect(patch(applyPatch(updateFile("src/a.ts", 1, 1)))).toMatch(
    /^3rd edit to src\/a\.ts this turn:/,
  );
  expect(patch(applyPatch(updateFile("src/b.ts", 1, 1)))).toBeNull(); // another file still has a fresh count
  // malformed patch text fails open
  expect(patch("not a patch\n+garbage\n-nope")).toBeNull();
  expect(patch("*** Begin Patch\n*** End Patch")).toBeNull();
});

test("context: the SessionStart hook prints a one-line pointer to delegate; the rules stay in the server instructions", () => {
  // a fresh cache means the update check makes no network call
  const out = contextOut(
    { checked: Date.now(), latest: version },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  );
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("delegate tool");
  expect(out.hookSpecificOutput.additionalContext).toContain(
    'task: "<what to change, which files, how to check>"',
  );
  expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(250); // rewritten every session, after the cache breakpoint
  expect(out.systemMessage).toBeUndefined();
});

/** Runs `hook context` hermetically, with a fresh cache the caller controls, so no test can touch the network or ~/.config. */
function contextOut(
  cache: { checked: number; latest: string },
  extraEnv: Record<string, string> = {},
  host?: "codex",
  stdin = "",
) {
  return JSON.parse(contextStdout(cache, extraEnv, host, stdin).stdout);
}

/** `hook context` run like contextOut, but returns the raw stdout and the cache file it ran with. */
function contextStdout(
  cache: { checked: number; latest: string },
  extraEnv: Record<string, string> = {},
  host?: "codex",
  stdin = "",
  cwd?: string,
) {
  const { home, env } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "config", "cheapag");
  mkdirSync(dir, { recursive: true });
  const cacheFile = join(dir, "update-check.json");
  writeFileSync(cacheFile, JSON.stringify(cache));
  const args = ["hook", "context", ...(host ? [host] : [])];
  const stdout = execFileSync(process.execPath, [serverEntry, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    input: stdin,
    encoding: "utf8",
  });
  return { stdout, cacheFile };
}

test("context codex: the SessionStart hook prints the full Codex instructions, including the hidden-tools warning", () => {
  const out = contextOut(
    { checked: Date.now(), latest: version },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
    "codex",
  );
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const text = out.hookSpecificOutput.additionalContext as string;
  expect(text).toContain("research");
  expect(text).toContain("An OK is done");
  expect(text).toContain("search for them");
  expect(text.length).toBeLessThanOrEqual(4096);
});

test("context: PLUGIN_ROOT marks Codex, so plain hook context prints the full Codex instructions", () => {
  const out = contextOut(
    { checked: Date.now(), latest: version },
    { CLAUDE_CODE_ENTRYPOINT: "cli", PLUGIN_ROOT: "/Users/x/.codex/plugins/cheapag" },
  );
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("search for them");
});

test("context: a transcript_path under .codex marks Codex, so plain hook context prints the full Codex instructions", () => {
  const stdin = JSON.stringify({ transcript_path: "/Users/x/.codex/sessions/a.jsonl" });
  const out = contextOut(
    { checked: Date.now(), latest: version },
    { CLAUDE_CODE_ENTRYPOINT: "cli", PLUGIN_ROOT: "" },
    undefined,
    stdin,
  );
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("search for them");
});

test("context: neither Codex signal keeps the byte-identical Claude one-liner", () => {
  const stdin = JSON.stringify({ transcript_path: "/Users/x/.claude/projects/a.jsonl" });
  const out = contextOut(
    { checked: Date.now(), latest: version },
    { CLAUDE_CODE_ENTRYPOINT: "cli", PLUGIN_ROOT: "" },
    undefined,
    stdin,
  );
  expect(out.hookSpecificOutput.additionalContext).toBe(SESSION_CONTEXT);
});

test("context: a newer minor or major version adds a yellow systemMessage and tells Claude to prompt the update", () => {
  const [major, minor] = version.split(".").map(Number);
  for (const latest of [`${major}.${minor + 1}.0`, `${major + 1}.0.0`]) {
    const out = contextOut({ checked: Date.now(), latest }, { CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(out.systemMessage).toBe(
      `\x1b[33mCheap Agent ${latest} is available (you have ${version}). Update: npx cheap-agent@latest\x1b[39m`,
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain(latest);
    expect(out.hookSpecificOutput.additionalContext).toContain("npx cheap-agent@latest");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      `${SESSION_CONTEXT} Cheap Agent ${latest} `,
    );
  }
});

test("context: in the desktop app the systemMessage has no colour but Claude is still told about the update", () => {
  const [major, minor] = version.split(".").map(Number);
  const latest = `${major}.${minor + 1}.0`;
  const out = contextOut(
    { checked: Date.now(), latest },
    { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
  );
  expect(out.systemMessage).not.toContain("\x1b[");
  expect(out.systemMessage).toBe(
    `Cheap Agent ${latest} is available (you have ${version}). Update: npx cheap-agent@latest`,
  );
  expect(out.hookSpecificOutput.additionalContext).toContain(latest);
  expect(out.hookSpecificOutput.additionalContext).toContain("npx cheap-agent@latest");
});

test("context: a newer patch alone does not notify", () => {
  const [major, minor, patch] = version.split(".").map(Number);
  const out = contextOut(
    { checked: Date.now(), latest: `${major}.${minor}.${patch + 1}` },
    { CLAUDE_CODE_ENTRYPOINT: "cli" },
  );
  expect(out.systemMessage).toBeUndefined();
  expect(out.hookSpecificOutput.additionalContext).toBe(SESSION_CONTEXT);
});

test("context: CHEAPAG_NO_UPDATE_CHECK=1 skips the check even when the cache has a newer minor", () => {
  const [major, minor] = version.split(".").map(Number);
  const out = contextOut(
    { checked: Date.now(), latest: `${major}.${minor + 1}.0` },
    { CHEAPAG_NO_UPDATE_CHECK: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
  );
  expect(out.systemMessage).toBeUndefined();
  expect(out.hookSpecificOutput.additionalContext).toBe(SESSION_CONTEXT);
});

const FAIL_BLOCK =
  "FAIL jab12 step=1 files=0 +0/-0 tests=pass turns=12 cost=$0.003\nfound: django/db/models/query.py:only(), proxy model pk\nreason: no reproduction test by turn 12";
const read = { file_path: "a.ts" };

test("takeover: a PROVIDER result starts no take-over: the provider is down, so Claude must not hand it to Sonnet", () => {
  const { run, result } = setup();
  result(
    "PROVIDER jab12 step=1 files=0 +0/-0 turns=0 cost=$0\nreason: opencode is down or overloaded on every allowed model: a, b (last error: overloaded); retry in a few minutes",
  );
  expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBeNull();
});

test("takeover self: after a FAIL, the call past limits.takeover_calls in that prompt is denied; cheapag's tools never count; a new prompt is free", () => {
  const { run, result, repo } = setup();
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ takeover: "self", limits: { takeover_calls: 3 } }),
  );
  expect(run("Read", read)).toBeNull(); // no take-over yet: the shell test skips node entirely
  result("OK jab11 step=1 files=1 +1/-1 tests=pass turns=4 cost=$0.002");
  for (let i = 0; i < 5; i++) expect(run("Bash", { command: "ls" })).toBeNull(); // an OK starts no count
  result(FAIL_BLOCK);
  for (let i = 0; i < 3; i++)
    expect(run(i ? "Bash" : "Read", i ? { command: "ls" } : read)).toBeNull();
  expect(run("mcp__plugin_cheapag_cheapag__land", { job: "jab12" })).toBeNull();
  const reason = run("Read", read);
  expect(reason).toMatch(
    /^Take-over budget spent \(3 tool calls after a cheapag FAIL or PARTIAL\): stop now and tell the user what is fixed, what is left and the failing test\./,
  );
  expect(reason).toContain("limits.takeover_calls");
  // a second failure in the same prompt does not reset the count
  result(FAIL_BLOCK.replace("jab12", "jab13"));
  expect(run("Bash", { command: "ls" })).toMatch(/^Take-over budget spent/);
  // the user's next prompt ends the take-over
  expect(run("Bash", { command: "ls" }, { prompt: "p2" })).toBeNull();
});

test("takeover self: PARTIAL and TIMEOUT start it too; limits.takeover_calls 0 turns it off", () => {
  const { run, result, repo } = setup();
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ takeover: "self", limits: { takeover_calls: 1 } }),
  );
  result(
    "PARTIAL jab14 step=1 files=1 +13/-0 tests=pass turns=25 cost=$0.012\nmissing:\n  - unknown",
  );
  expect(run("Read", read)).toBeNull();
  expect(run("Read", read)).toMatch(/^Take-over budget spent \(1 tool calls/);
  result(
    "TIMEOUT jab15 step=1 files=0 +0/-0 turns=9 cost=$0.01\nreason: minute cap",
    "p2",
    "mcp__cheapag__jobs",
  );
  expect(run("Read", read, { prompt: "p2" })).toBeNull();
  expect(run("Read", read, { prompt: "p2" })).toMatch(/^Take-over budget spent/);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ takeover: "self", limits: { takeover_calls: 0 } }),
  );
  expect(run("Read", read, { prompt: "p2" })).toBeNull();
});

test(
  "takeover sonnet: after a FAIL, only the Agent tool, read-only tools and cheapag's tools are left; the subagent works freely; a new prompt is free",
  () => {
    const { run, result, repo } = setup();
    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "sonnet" }));
    result(FAIL_BLOCK);
    const reason = run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" });
    expect(reason).toMatch(
      /^The worker did not finish this step: hand it to your Agent tool with model: sonnet \(the task, the user's words, the block's found:, test=, error: and worktree\)/,
    );
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
    for (let i = 0; i < 4; i++)
      expect(
        run(
          i % 2 ? "Edit" : "Bash",
          i % 2
            ? { file_path: "a.ts", old_string: "a", new_string: "b" }
            : { command: "pytest -q" },
          { agent: "ab9d" },
        ),
      ).toBeNull();
    expect(run("Read", read, { prompt: "p2" })).toBeNull();
  },
  slow(20_000),
);

test("takeover sonnet: cd/env prefixes and git's -C/--no-pager/-c options stay reads; edits outside the repo pass; an env FAIL blocks nothing", () => {
  const { run, result, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "sonnet" }));
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
  expect(run("Write", { file_path: join(repo.dir, "inside.ts"), content: "x" })).toMatch(
    /^The worker did not finish/,
  );
  expect(run("Write", { file_path: "/tmp/outside.ts", content: "x" })).toBeNull();
  expect(run("NotebookEdit", { notebook_path: "/tmp/n.ipynb" })).toBeNull();
  // an OK the worker applied or discarded clears the earlier FAIL even without a check
  result("OK j1 discarded");
  expect(run("Bash", { command: "npm test" })).toBeNull();
});

test("takeover ask (default): after a FAIL, reads pass but Agent and repo edits are denied with the one-question message; AskUserQuestion clears it", () => {
  const { run, result, repo } = setup();
  result(FAIL_BLOCK);
  expect(run("Read", read)).toBeNull();
  expect(run("Bash", { command: "git diff -- src/a.ts" })).toBeNull();
  expect(run("mcp__cheapag__land", { job: "jab12" })).toBeNull();
  expect(run("ToolSearch", { query: "delegate" })).toBeNull();
  expect(run("mcp__ccd_turn__wrap_up", {})).toBeNull();
  const message =
    "The worker did not finish this step: ask the user first (continue with Claude, retry the worker on another model, or stop) with one question, then do what they pick.";
  expect(run("Agent", { model: "sonnet", prompt: "finish it" })).toBe(message);
  expect(run("Edit", { file_path: join(repo.dir, "a.ts"), old_string: "a", new_string: "b" })).toBe(
    message,
  );
  expect(run("Bash", { command: "echo x > f" })).toBe(message);
  expect(run("Bash", { command: "npm test" })).toBe(message);
  // asking the user is the way out: whatever they pick is theirs
  expect(
    run("AskUserQuestion", { questions: [{ question: "Continue?", options: [] }] }),
  ).toBeNull();
  expect(run("Agent", { model: "sonnet", prompt: "finish it" })).toBeNull();
  expect(
    run("Edit", { file_path: join(repo.dir, "a.ts"), old_string: "a", new_string: "b" }),
  ).toBeNull();
});

const PERMISSION_BLOCK = [
  "BLOCKED jab12 step=1 permission",
  "title: inspect the top of the file",
  "command: sed -n 1,2p f",
  "why: need to see the file's first lines",
  "a) allow once",
  "b) always allow `sed` in this repo (adds it to cheapag.json allow_commands)",
  "c) refuse",
  "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.",
].join("\n");
const REPLY_TOOL = "mcp__plugin_cheapag_cheapag__reply";

test("permission block: reply is denied until AskUserQuestion has run since the block", () => {
  const { run, result } = setup();
  const message =
    "This job is asking for a command permission: ask the user with AskUserQuestion first, then reply with their answer.";
  result(PERMISSION_BLOCK);
  expect(run(REPLY_TOOL, { job: "jab12", answer: "a" })).toBe(message);
  expect(run("mcp__cheapag__reply", { job: "jab12", answer: "a" })).toBe(message);
  // another job's reply is not this job's decision
  expect(run(REPLY_TOOL, { job: "jother", answer: "a" })).toBeNull();
  // asking the user clears it: whatever they pick is theirs
  expect(
    run("AskUserQuestion", { questions: [{ question: "Allow sed?", options: [] }] }),
  ).toBeNull();
  expect(run(REPLY_TOOL, { job: "jab12", answer: "a" })).toBeNull();
});

test("permission block: a plain question block does not make reply wait for AskUserQuestion", () => {
  const { run, result } = setup();
  result(
    [
      "BLOCKED jab12 step=1",
      "question: which database?",
      "a) postgres",
      "b) sqlite",
      "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.",
    ].join("\n"),
  );
  expect(run(REPLY_TOOL, { job: "jab12", answer: "a" })).toBeNull();
});

test("takeover sonnet: asking and the desktop app's own tools are allowed after a FAIL", () => {
  const { run, result, repo } = setup();
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "sonnet" }));
  result(FAIL_BLOCK);
  expect(run("AskUserQuestion", { questions: [] })).toBeNull();
  expect(run("ToolSearch", { query: "delegate" })).toBeNull();
  expect(run("mcp__ccd_turn__wrap_up", {})).toBeNull();
});

test("takeover: an env-kind FAIL leaves the guard off (nothing for the taker to finish)", () => {
  const { run, result } = setup();
  result(
    "FAIL j1 step=1 files=0 +0/-0 tests=fail turns=3 cost=$0.001 check=env\nreason: command not found",
  );
  expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBeNull();
});

test(
  "trust OK: after an OK whose checks passed, re-running tests is denied; other tools pass; tests=none and a new prompt are free; a later FAIL wins",
  () => {
    const { run, result } = setup();
    result("OK jab21 step=1 files=1 +1/-1 tests=none turns=4 cost=$0.002");
    expect(run("Bash", { command: "npm test" })).toBeNull(); // nothing ran in the worktree: Claude may test
    result("OK jab22 step=1 files=1 +1/-1 tests=pass turns=4 cost=$0.002 repro=unverified");
    for (const command of [
      "./swebench-test.sh migrations.test_commands",
      "python -m pytest tests/x.py",
      "npx vitest run a.test.ts",
      "cd pkg && go test ./...",
    ]) {
      expect(run("Bash", { command })).toBe(
        "An OK is done: its checks already passed in the worker's worktree, so don't re-run tests. Report the result, or delegate the next step.",
      );
    }
    expect(run("Bash", { command: "git status --short" })).toBeNull();
    expect(run("Read", read)).toBeNull();
    expect(run("Bash", { command: "pytest -q" }, { agent: "ab9d" })).toBeNull(); // a subagent may test
    expect(run("Bash", { command: "npm test" }, { prompt: "p2" })).toBeNull();
    result(FAIL_BLOCK, "p2");
    expect(
      run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, { prompt: "p2" }),
    ).toMatch(/^The worker did not finish/);
  },
  slow(20_000),
);

test("cheapag hook outside a repository fails with the reason; a damaged cheapag.json shows in place of the line limit", () => {
  const { cli, repo, env } = setup();
  const { home } = hermeticHome();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const outside = spawnSync(process.execPath, [serverEntry, "hook"], {
    cwd: home,
    env,
    encoding: "utf8",
  });
  expect(outside.status).toBe(1);
  expect(outside.stdout).toBe(`✗ ${home} is not inside a git repository\n`);
  writeFileSync(join(repo.dir, "cheapag.json"), "{ not json");
  expect(cli("on")).toMatch(
    /^✓ edit guard on for .*: an edit over \? \(.*cheapag\.json is not valid JSON: .*\) changed lines, /,
  );
});

test("result: a tool response with no text records nothing", () => {
  const { repo, env } = setup();
  for (const tool_response of [42, null, { content: 7 }]) {
    const input = {
      session_id: "s1",
      prompt_id: "p1",
      cwd: repo.dir,
      hook_event_name: "PostToolUse",
      tool_name: "mcp__plugin_cheapag_cheapag__delegate",
      tool_input: {},
      tool_response,
    };
    const r = spawnSync(process.execPath, [serverEntry, "hook", "result"], {
      cwd: repo.dir,
      env,
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }
  expect(existsSync(join(repo.dir, ".cheapag", "hook"))).toBe(false);
});

/** `cheapag hook context codex` in this process with the registry stubbed; returns the printed JSON and the cache it left. */
async function contextWithRegistry(registry: () => Promise<unknown>, cache?: object) {
  const { home } = hermeticHome();
  const cacheFile = join(home, "config", "cheapag", "update-check.json");
  if (cache) {
    mkdirSync(join(cacheFile, ".."), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  vi.stubEnv("CHEAPAG_NO_UPDATE_CHECK", "");
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "claude-desktop"); // no colour codes
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => (fetched.push(String(url)), { json: registry }));
  let printed = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => ((printed += chunk), true));
  try {
    expect(await hook(["context", "codex"])).toBe(0);
  } finally {
    stdout.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  const savedText = readFileSync(cacheFile, "utf8");
  const saved = JSON.parse(savedText) as { checked: number; latest: string };
  rmSync(home, { recursive: true, force: true });
  return { out: JSON.parse(printed) as { systemMessage?: string }, saved, fetched, savedText };
}

test("context: without a fresh cache the registry is asked once, and its answer (or the old one, when it fails) is cached for a day", async () => {
  const [major, minor] = version.split(".").map(Number);
  const next = `${major}.${minor + 1}.0`;
  const message = `Cheap Agent ${next} is available (you have ${version}). Update: npx cheap-agent@latest`;
  const started = Date.now();

  const first = await contextWithRegistry(async () => ({ version: next }));
  expect(first.fetched).toEqual(["https://registry.npmjs.org/cheap-agent/latest"]);
  expect(first.out.systemMessage).toBe(message);
  expect(first.saved.latest).toBe(next);
  expect(first.saved.checked).toBeGreaterThanOrEqual(started);

  // a stale cache and an unreachable registry: the old latest still stands, and the check time moves on
  const offline = await contextWithRegistry(() => Promise.reject(new Error("offline")), {
    checked: 0,
    latest: next,
  });
  expect(offline.out.systemMessage).toBe(message);
  expect(offline.saved.latest).toBe(next);
  expect(offline.saved.checked).toBeGreaterThanOrEqual(started);

  // an answer without a version string and nothing cached: no notice, and an empty latest is cached
  const odd = await contextWithRegistry(async () => ({ version: 5 }));
  expect(odd.out.systemMessage).toBeUndefined();
  expect(odd.saved.latest).toBe("");
});

// Characterization tests: Claude Code parses this output and shows it to the user, so every key, its order, every
// message character and the exit code are pinned.

const REDIRECT =
  "write a plan step and use the cheapag server's delegate tool (mcp__plugin_cheapag_cheapag__delegate, or mcp__cheapag__delegate) instead.";

/** The exact line `hook guard` prints for a deny. */
const denial = (reason: string) =>
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":${JSON.stringify(reason)}}}\n`;

/** Runs `hook <args>` with no shell test in front; returns the exit code and raw stdout. */
function rawHook(
  args: string[],
  options: { cwd: string; env: Record<string, string>; input?: unknown },
) {
  const { input } = options;
  const r = spawnSync(process.execPath, [serverEntry, "hook", ...args], {
    cwd: options.cwd,
    env: options.env,
    input: typeof input === "string" ? input : JSON.stringify(input ?? {}),
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout };
}

/** The message a config load throws for `root`, read with the hermetic home's user config. */
function configError(root: string, home: string) {
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  try {
    loadConfig(root);
  } catch (err) {
    return (err as Error).message;
  } finally {
    vi.unstubAllEnvs();
  }
  throw new Error("expected the config load to fail");
}

test(
  "cli: the exact usage, on and off lines, exit codes and flag file",
  () => {
    const { repo, env } = setup();
    const { home } = hermeticHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const cli = (args: string[], cwd = repo.dir) => rawHook(args, { cwd, env, input: "" });
    const usage = { status: 1, stdout: "✗ usage: cheapag hook [on | off]\n" };
    for (const args of [
      ["maybe"],
      ["on", "off"],
      ["guard", "x"],
      ["result", "x"],
      ["context", "claude"],
      ["context", "codex", "x"],
    ]) {
      expect(cli(args), args.join(" ")).toEqual(usage);
    }
    // the usage check comes before the repository check
    expect(cli(["maybe"], home)).toEqual(usage);
    expect(cli(["on"], home)).toEqual({
      status: 1,
      stdout: `✗ ${home} is not inside a git repository\n`,
    });
    expect(existsSync(join(home, ".cheapag"))).toBe(false);

    const on = `✓ edit guard on for ${repo.dir}: an edit over 20 changed lines, a 3rd edit to one file in a turn, or a Bash command writing a file is denied with a pointer to delegate (.plan/ is exempt). CHEAPAG_ALLOW_EDITS=1 bypasses it.\n`;
    const off = `✓ edit guard off for ${repo.dir}: Claude's edits are not limited.\n`;
    const flagFile = join(repo.dir, ".cheapag", "hook.json");
    expect(cli([])).toEqual({ status: 0, stdout: off });
    expect(cli(["on"])).toEqual({ status: 0, stdout: on });
    expect(readFileSync(flagFile, "utf8")).toBe('{"on":true}\n');
    expect(cli([])).toEqual({ status: 0, stdout: on });
    expect(cli(["on"])).toEqual({ status: 0, stdout: on });
    expect(cli(["off"])).toEqual({ status: 0, stdout: off });
    expect(existsSync(flagFile)).toBe(false);
    expect(cli(["off"])).toEqual({ status: 0, stdout: off });
    // from a subdirectory, the flag goes in the repository root
    mkdirSync(join(repo.dir, "sub"));
    expect(cli(["on"], join(repo.dir, "sub"))).toEqual({ status: 0, stdout: on });
    expect(existsSync(flagFile)).toBe(true);

    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "bogus" }));
    const message = configError(repo.dir, home);
    expect(cli([])).toEqual({
      status: 0,
      stdout: on.replace("over 20 changed", `over ? (${message}) changed`),
    });
  },
  slow(20_000),
);

test(
  "guard: a deny is one JSON line with fixed key order, and each edit-guard reason is exact",
  () => {
    const { repo, env, cli } = setup();
    cli("on");
    const guard = (tool_name: string, tool_input: unknown, extra: object = {}) =>
      rawHook(["guard"], {
        cwd: repo.dir,
        env,
        input: {
          session_id: "s1",
          prompt_id: "p1",
          cwd: repo.dir,
          tool_name,
          tool_input,
          ...extra,
        },
      });
    const denied = (reason: string) => ({ status: 0, stdout: denial(reason) });
    const allowed = { status: 0, stdout: "" };
    expect(guard("Write", { file_path: "big.ts", content: lines(21) })).toEqual(
      denied(`Large edit (21 changed lines, over 20): ${REDIRECT}`),
    );
    expect(guard("Bash", { command: "echo hi > src/a.js" })).toEqual(
      denied(`Bash writing src/a.js: ${REDIRECT}`),
    );
    expect(guard("Bash", { command: "sed -i 's/a/b/' src/a.js" })).toEqual(
      denied(`Bash in-place edit (sed/perl -i): ${REDIRECT}`),
    );
    expect(guard("Bash", { command: "python3 -c \"open('src/x.js','w')\"" })).toEqual(
      denied(`Bash running code that writes files: ${REDIRECT}`),
    );
    // a written file is named before an in-place edit in the same command
    expect(guard("Bash", { command: "sed -i 's/a/b/' src/a.js > src/out.txt" })).toEqual(
      denied(`Bash writing src/out.txt: ${REDIRECT}`),
    );
    expect(guard("apply_patch", { command: applyPatch(addFile("big.ts", 21)) })).toEqual(
      denied(`Large edit (21 changed lines, over 20): ${REDIRECT}`),
    );
    // the size rule is not limited to the repository: a large Write anywhere is denied
    expect(guard("Write", { file_path: "/nonexistent-dir/big.ts", content: lines(21) })).toEqual(
      denied(`Large edit (21 changed lines, over 20): ${REDIRECT}`),
    );
    // inputs the guard cannot read are allowed
    expect(guard("Bash", { command: 42 })).toEqual(allowed);
    expect(guard("apply_patch", { command: ["x"] })).toEqual(allowed);
    expect(guard("Edit", { old_string: "a", new_string: lines(30) })).toEqual(allowed);
    expect(guard("Write", { file_path: "big.ts", content: lines(21) }, { cwd: 7 })).toEqual(
      allowed,
    );
    expect(guard("MultiEdit", { file_path: "m.ts", edits: "x" })).toEqual(allowed);
    expect(guard("Write", { file_path: "big.ts", content: 9 })).toEqual(allowed);
    expect(rawHook(["guard"], { cwd: repo.dir, env, input: "null" })).toEqual(allowed);
    // a cwd outside any repository fails open
    const { home } = hermeticHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    expect(guard("Write", { file_path: "big.ts", content: lines(21) }, { cwd: home })).toEqual(
      allowed,
    );
    // a damaged cheapag.json fails open too
    writeFileSync(join(repo.dir, "cheapag.json"), "{ not json");
    expect(guard("Write", { file_path: "big.ts", content: lines(21) })).toEqual(allowed);
  },
  slow(20_000),
);

test(
  "guard: without a prompt_id only the size rule applies; the turn file holds each file's count",
  () => {
    const { repo, env, cli } = setup();
    cli("on");
    const editA = (extra: object) =>
      rawHook(["guard"], {
        cwd: repo.dir,
        env,
        input: {
          cwd: repo.dir,
          tool_name: "Edit",
          tool_input: { file_path: "a.ts", old_string: "1", new_string: "2" },
          ...extra,
        },
      });
    for (let i = 0; i < 4; i++)
      expect(editA({ session_id: "s1" })).toEqual({ status: 0, stdout: "" });
    expect(existsSync(join(repo.dir, ".cheapag", "hook"))).toBe(false);
    // the session id is made safe for a file name
    const session = { session_id: "a/b c", prompt_id: "p1" };
    expect(editA(session)).toEqual({ status: 0, stdout: "" });
    expect(editA(session)).toEqual({ status: 0, stdout: "" });
    expect(readFileSync(join(repo.dir, ".cheapag", "hook", "a_b_c.json"), "utf8")).toBe(
      JSON.stringify({ prompt: "p1", edits: { [join(repo.dir, "a.ts")]: 2 } }),
    );
    expect(editA(session)).toEqual({
      status: 0,
      stdout: denial(`3rd edit to a.ts this turn: ${REDIRECT}`),
    });
    // a denied edit is not counted
    expect(
      JSON.parse(readFileSync(join(repo.dir, ".cheapag", "hook", "a_b_c.json"), "utf8")).edits,
    ).toEqual({ [join(repo.dir, "a.ts")]: 2 });
  },
  slow(20_000),
);

test(
  "apply_patch: a denied patch counts none of its files; Move to keeps a section, other *** lines end it",
  () => {
    const { run, cli } = setup();
    cli("on");
    const patch = (command: string) => run("apply_patch", { command });
    expect(patch(applyPatch(updateFile("src/c.ts", 1, 1), addFile("big.ts", 21)))).toBe(
      `Large edit (21 changed lines, over 20): ${REDIRECT}`,
    );
    expect(patch(applyPatch(updateFile("src/c.ts", 1, 1)))).toBeNull();
    expect(patch(applyPatch(updateFile("src/c.ts", 1, 1)))).toBeNull();
    expect(patch(applyPatch(updateFile("src/c.ts", 1, 1)))).toBe(
      `3rd edit to src/c.ts this turn: ${REDIRECT}`,
    );
    const plus = (n: number) => Array.from({ length: n }, (_, i) => `+p${i}`);
    const minus = (n: number) => Array.from({ length: n }, (_, i) => `-m${i}`);
    expect(
      patch(
        applyPatch(
          ["*** Update File: src/m.ts", "*** Move to: src/n.ts", "@@", ...plus(21)].join("\n"),
        ),
      ),
    ).toBe(`Large edit (21 changed lines, over 20): ${REDIRECT}`);
    expect(patch(applyPatch(["*** Delete File: src/d.ts", ...minus(21)].join("\n")))).toBe(
      `Large edit (21 changed lines, over 20): ${REDIRECT}`,
    );
    expect(
      patch(
        applyPatch(
          ["*** Update File: src/e.ts", "@@", ...plus(10), "*** End of File", ...plus(15)].join(
            "\n",
          ),
        ),
      ),
    ).toBeNull();
    // plan files in a patch are skipped, the rest still counted
    expect(patch(applyPatch(addFile(".plan/p.md", 50), updateFile("src/f.ts", 11, 11)))).toBe(
      `Large edit (22 changed lines, over 20): ${REDIRECT}`,
    );
  },
  slow(20_000),
);

test(
  "take-over reasons are exact",
  () => {
    const { run, result, repo } = setup();
    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ takeover: "sonnet" }));
    result(FAIL_BLOCK);
    expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBe(
      `The worker did not finish this step: hand it to your Agent tool with model: sonnet (the task, the user's words, the block's found:, test=, error: and worktree) instead of doing it yourself, then report its answer. The user can set takeover: "self" in cheapag.json.`,
    );
    // Task hands off like Agent
    expect(run("Task", { prompt: "finish it" })).toBeNull();
    expect(run("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })).toBeNull();
    writeFileSync(
      join(repo.dir, "cheapag.json"),
      JSON.stringify({ takeover: "self", limits: { takeover_calls: 1 } }),
    );
    result(FAIL_BLOCK, "p2");
    expect(run("Read", read, { prompt: "p2" })).toBeNull();
    expect(run("Read", read, { prompt: "p2" })).toBe(
      "Take-over budget spent (1 tool calls after a cheapag FAIL or PARTIAL): stop now and tell the user what is fixed, what is left and the failing test. The user can raise limits.takeover_calls in cheapag.json.",
    );
  },
  slow(20_000),
);

test(
  "takeover ask: which Bash commands count as reads",
  () => {
    const { run, result } = setup();
    result(FAIL_BLOCK);
    for (const command of [
      "cd",
      "export X=1 && git log",
      "echo hi",
      "pwd",
      "git diff | wc -l",
      "rg x src; find . -name a",
      "A=1 B=2 git --no-pager -C /x show HEAD",
      "cat",
    ]) {
      expect(run("Bash", { command }), command).toBeNull();
    }
    for (const command of [
      "",
      "  ",
      "git log || rm x",
      'git log --format=">"',
      "npx vitest",
      "sed -i s/a/b/ f",
      "perl --in-place -pe 1 f",
      "node -e \"require('fs').writeFileSync('f','1')\"",
      "tee f",
      "cp a b",
      "gitx log",
    ]) {
      expect(run("Bash", { command }), command).toMatch(
        /^The worker did not finish this step: ask the user/,
      );
    }
    expect(run("Bash", { command: 3 })).toMatch(/^The worker did not finish/);
    // an edit to the repository root itself is not outside it
    expect(run("Write", { file_path: ".", content: "x" })).toMatch(/^The worker did not finish/);
    expect(run("NotebookEdit", { notebook_path: "/tmp/n.ipynb" })).toBeNull();
    expect(run("NotebookEdit", { notebook_path: "n.ipynb" })).toMatch(/^The worker did not finish/);
  },
  slow(20_000),
);

test(
  "result and guard: the take-over state file and marker they write, exactly",
  () => {
    const { run, result, repo } = setup();
    const stateFile = join(repo.dir, ".cheapag", "hook", "s1.takeover.json");
    const state = () => readFileSync(stateFile, "utf8");
    result(FAIL_BLOCK);
    expect(state()).toBe('{"prompt":"p1","calls":0,"notDone":true}');
    expect(readFileSync(join(repo.dir, ".cheapag", "hook", "takeover"), "utf8")).toBe("");
    result("OK jab22 step=1 files=1 +1/-1 tests=pass turns=4 cost=$0.002");
    expect(state()).toBe('{"prompt":"p1","calls":0,"notDone":true,"okPassed":true}');
    result("OK j1 applied");
    expect(state()).toBe('{"prompt":"p1","calls":0,"okPassed":true}');
    result(PERMISSION_BLOCK);
    expect(state()).toBe('{"prompt":"p1","calls":0,"okPassed":true,"permission":"jab12"}');
    // a result that means nothing leaves the state alone
    result("OK jab30 step=1 files=1 +1/-1 tests=none turns=4 cost=$0.002", "p9");
    expect(state()).toBe('{"prompt":"p1","calls":0,"okPassed":true,"permission":"jab12"}');
    // a new prompt, or a damaged state file, starts fresh
    result(FAIL_BLOCK, "p2");
    expect(state()).toBe('{"prompt":"p2","calls":0,"notDone":true}');
    writeFileSync(stateFile, "garbage");
    result(FAIL_BLOCK, "p3");
    expect(state()).toBe('{"prompt":"p3","calls":0,"notDone":true}');

    // one AskUserQuestion clears both a permission block and a FAIL in ask mode
    result(PERMISSION_BLOCK, "p3");
    expect(state()).toBe('{"prompt":"p3","calls":0,"notDone":true,"permission":"jab12"}');
    expect(run(REPLY_TOOL, { job: 7, answer: "a" }, { prompt: "p3" })).toBe(
      "This job is asking for a command permission: ask the user with AskUserQuestion first, then reply with their answer.",
    );
    expect(run("AskUserQuestion", { questions: [] }, { prompt: "p3" })).toBeNull();
    expect(state()).toBe('{"prompt":"p3","calls":0}');
    // with no flag left the config is still loaded, so a damaged cheapag.json allows even a Bash write
    const flagFile = join(repo.dir, ".cheapag", "hook.json");
    const bashWrite = { command: "echo x > src/a.js" };
    writeFileSync(flagFile, "{}");
    writeFileSync(join(repo.dir, "cheapag.json"), "{ not json");
    expect(run("Bash", bashWrite, { prompt: "p3" })).toBeNull();
    writeFileSync(join(repo.dir, "cheapag.json"), "{}");
    expect(run("Bash", bashWrite, { prompt: "p3" })).toBe(`Bash writing src/a.js: ${REDIRECT}`);
    rmSync(flagFile);

    writeFileSync(
      join(repo.dir, "cheapag.json"),
      JSON.stringify({ takeover: "self", limits: { takeover_calls: 5 } }),
    );
    result(FAIL_BLOCK, "p4");
    expect(run("Read", read, { prompt: "p4" })).toBeNull();
    expect(run("mcp__cheapag__jobs", {}, { prompt: "p4" })).toBeNull();
    expect(state()).toBe('{"prompt":"p4","calls":1,"notDone":true}');
    // a damaged cheapag.json during a take-over fails open, even for an edit the guard would deny
    writeFileSync(join(repo.dir, "cheapag.json"), "{ not json");
    writeFileSync(join(repo.dir, ".cheapag", "hook.json"), "{}");
    expect(run("Write", { file_path: "big.ts", content: lines(60) }, { prompt: "p4" })).toBeNull();
    expect(state()).toBe('{"prompt":"p4","calls":1,"notDone":true}');
  },
  slow(20_000),
);

test(
  "result: a subagent's call, a missing prompt or session, or a non-string cwd records nothing",
  () => {
    const { repo, env } = setup();
    const base = {
      session_id: "s1",
      prompt_id: "p1",
      cwd: repo.dir,
      tool_name: "mcp__cheapag__delegate",
      tool_response: FAIL_BLOCK,
    };
    for (const input of [
      { ...base, agent_id: "ab9d" },
      { ...base, prompt_id: undefined },
      { ...base, session_id: "" },
      { ...base, cwd: 1 },
    ]) {
      expect(rawHook(["result"], { cwd: repo.dir, env, input })).toEqual({ status: 0, stdout: "" });
    }
    expect(rawHook(["result"], { cwd: repo.dir, env, input: "not json" })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(existsSync(join(repo.dir, ".cheapag", "hook"))).toBe(false);
    // a plain string response and a nested content object both count
    expect(rawHook(["result"], { cwd: repo.dir, env, input: base })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(readFileSync(join(repo.dir, ".cheapag", "hook", "s1.takeover.json"), "utf8")).toBe(
      '{"prompt":"p1","calls":0,"notDone":true}',
    );
    const nested = { ...base, prompt_id: "p2", tool_response: { content: [{ text: FAIL_BLOCK }] } };
    expect(rawHook(["result"], { cwd: repo.dir, env, input: nested })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(readFileSync(join(repo.dir, ".cheapag", "hook", "s1.takeover.json"), "utf8")).toBe(
      '{"prompt":"p2","calls":0,"notDone":true}',
    );
  },
  slow(20_000),
);

test(
  "context: the exact stdout JSON, with and without an update, for Claude and Codex",
  () => {
    const [major, minor] = version.split(".").map(Number);
    const latest = `${major}.${minor + 1}.0`;
    const notice = `Cheap Agent ${latest} is available (you have ${version}). Update: npx cheap-agent@latest`;
    const tell = ` Cheap Agent ${latest} is available (the user has ${version}): at the start of your first reply, tell the user in one line to update with \`npx cheap-agent@latest\`.`;
    const line = (additionalContext: string, systemMessage?: string) =>
      (systemMessage === undefined ? "{" : `{"systemMessage":${JSON.stringify(systemMessage)},`) +
      `"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":${JSON.stringify(additionalContext)}}}\n`;
    const cli = { CLAUDE_CODE_ENTRYPOINT: "cli", PLUGIN_ROOT: "", CHEAPAG_NO_UPDATE_CHECK: "" };
    const fresh = (cachedLatest: string) => ({ checked: Date.now(), latest: cachedLatest });

    expect(contextStdout(fresh(version), cli).stdout).toBe(line(SESSION_CONTEXT));
    expect(contextStdout(fresh(latest), cli).stdout).toBe(
      line(SESSION_CONTEXT + tell, `\x1b[33m${notice}\x1b[39m`),
    );
    // a fresh cache is used as-is: nothing is written back
    const kept = { checked: Date.now() - 1000, latest: "" };
    const plain = contextStdout(kept, cli);
    expect(plain.stdout).toBe(line(SESSION_CONTEXT));
    expect(readFileSync(plain.cacheFile, "utf8")).toBe(JSON.stringify(kept));
    // anything but x.y.z is never announced
    for (const odd of [`${major + 1}.0.0-beta.1`, `v${major + 1}.0.0`, `${major + 1}.0`]) {
      expect(contextStdout(fresh(odd), cli).stdout, odd).toBe(line(SESSION_CONTEXT));
    }
    // stdin that is not JSON is not Codex
    expect(contextStdout(fresh(version), cli, undefined, "not json").stdout).toBe(
      line(SESSION_CONTEXT),
    );

    // Codex gets the server's Codex instructions for the repository it runs in
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    const { home } = hermeticHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
    const codexBase = hostInstructions("codex", repo.dir);
    vi.unstubAllEnvs();
    expect(contextStdout(fresh(version), cli, "codex", "", repo.dir).stdout).toBe(line(codexBase));
    expect(contextStdout(fresh(latest), cli, "codex", "", repo.dir).stdout).toBe(
      line(codexBase + tell, `\x1b[33m${notice}\x1b[39m`),
    );
  },
  slow(20_000),
);

test("context: the refreshed cache file is exactly checked then latest, with no newline", async () => {
  const fetched = await contextWithRegistry(async () => ({ version: "1.0.0" }));
  expect(fetched.savedText).toMatch(/^\{"checked":\d+,"latest":"1\.0\.0"\}$/);
  const odd = await contextWithRegistry(async () => ({}));
  expect(odd.savedText).toMatch(/^\{"checked":\d+,"latest":""\}$/);
});
