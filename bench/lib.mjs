// Shared by the benchmark runners (bench/run.mjs, bench/swe/run.mjs): the claude -p call, worker and transcript metrics,
// the plugin copy pointed at this repo's build, and small helpers.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = dirname(dirname(new URL(import.meta.url).pathname));
export const dist = join(root, "dist", "index.js");

export function claude(args, cwd, timeoutMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: { ...process.env, CHEAPAG_BENCH: "1", DISABLE_AUTOUPDATER: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

/** Worker spend and job outcomes from the run's .cheapag/jobs records. */
export function workerMetrics(dir) {
  const jobsDir = join(dir, ".cheapag", "jobs");
  const jobs = existsSync(jobsDir) ? readdirSync(jobsDir).map((id) => join(jobsDir, id, "result.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8"))) : [];
  const statuses = {};
  for (const j of jobs) statuses[j.status] = (statuses[j.status] ?? 0) + 1;
  return {
    worker_cost_usd: jobs.reduce((s, j) => s + (j.usage?.costUsd ?? 0), 0),
    worker_turns: jobs.reduce((s, j) => s + (j.usage?.turns ?? 0), 0),
    jobs: jobs.length, job_statuses: statuses,
    self_fixes: jobs.reduce((s, j) => s + (j.selfFix?.length ?? 0), 0),
    escalations: jobs.filter((j) => j.models?.escalated).length,
  };
}

/** Tool-use counts from the Claude Code transcript: did Claude delegate, and did it edit code itself (incl. after a delegation)? */
export function transcriptMetrics(sessionId) {
  const empty = { tool_calls_before_first_delegate: 0, test_runs: 0, turns_after_last_delegate: 0, prefix_tokens: 0, cache_write_first_turn: 0, max_context: 0, tool_uses: 0, tools_used: {}, bash_writes: 0, delegate_calls: 0, research_calls: 0, agent_calls: 0, difficulty_hint: null, claude_edits: 0, claude_edits_after_delegate: 0, tool_uses_after_last_cheapag: 0, takeover_calls: 0, takeover_denied: false, handoff_denied: false, ok_test_denied: false };
  if (!sessionId) return empty;
  const projects = join(homedir(), ".claude", "projects");
  const file = existsSync(projects) ? readdirSync(projects).map((p) => join(projects, p, `${sessionId}.jsonl`)).find(existsSync) : undefined;
  if (!file) return empty;
  const names = [];
  let bashWrites = 0;
  let maxContext = 0;
  let testRuns = 0;
  let hint = null;
  let takeoverStart = -1; // ticket 29: tool calls so far when the first cheapag FAIL/PARTIAL/TIMEOUT came back
  let denied = false, handoffDenied = false, okTestDenied = false;
  const turns = []; // per assistant message: did it call delegate (or reply)?
  let first; // the first turn's usage: what the session's fixed prefix cost (ticket 23.1) // the largest context Claude was sent on one turn: input + cache reads + cache writes

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const u = e?.message?.usage;
    if (u) first ??= u;
    if (u) maxContext = Math.max(maxContext, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    if (e?.message?.role === "assistant" && e.message.id && turns.at(-1)?.id !== e.message.id) turns.push({ id: e.message.id, delegated: false });
    for (const c of e?.message?.content ?? []) {
      if (c.type === "tool_result") {
        const out = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
        if (takeoverStart < 0 && /^(?:FAIL|PARTIAL|TIMEOUT) j\w+ /m.test(out)) takeoverStart = names.length;
        if (out.includes("Take-over budget spent")) denied = true;
        if (out.includes("hand it to your Agent tool with model: sonnet")) handoffDenied = true;
        if (out.includes("An OK is done: its checks already passed")) okTestDenied = true;
      }
      if (c.type !== "tool_use") continue;
      if (/^mcp__.*cheapag.*__(delegate|reply)$/.test(c.name) && turns.length) turns.at(-1).delegated = true;
      // ticket 26: Claude's rating, last delegate call wins, so a mis-rating is visible per row
      if (/^mcp__.*cheapag.*__delegate$/.test(c.name) && c.input?.difficulty) hint = c.input.difficulty;
      // a test command: the benches' test scripts and the usual runners
      if (c.name === "Bash" && /swebench-test\.sh|\bpytest\b|runtests\.py|bin\/test\b|\bnpm (run )?test\b|node --test|\btox\b/.test(String(c.input?.command ?? ""))) testRuns++;
      names.push(c.name);
      // a Bash command that writes files (heredoc, redirect, sed -i, python/node one-liners) edits code without the Edit tools or the hook
      const cmd = String(c.input?.command ?? "").replace(/\d?>>?\s*\/dev\/null|\d?>&\d/g, "");
      if (c.name === "Bash" && /<<|(?:^|[^<>])>>?\s*["']?[\w./-]+|\bsed\s+-i|\bperl\s+-i|\btee\s+[\w./-]|python3? -c.*open\(|node -e.*writeFile/.test(cmd)) bashWrites++;
    }
  }
  const isCheapag = (n) => /^mcp__.*cheapag.*__(delegate|research|reply|jobs|land)$/.test(n);
  const isEdit = (n) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n);
  const lastCheapag = names.map(isCheapag).lastIndexOf(true);
  const lastDelegate = names.map((n) => /__(delegate|reply)$/.test(n) && isCheapag(n)).lastIndexOf(true);
  const lastDelegateTurn = turns.map((t) => t.delegated).lastIndexOf(true);
  const firstDelegate = names.findIndex((n) => isCheapag(n) && /__delegate$/.test(n));
  return {
    // what Claude read, searched or ran before handing off (ticket 23.4); the whole session when it never delegated
    tool_calls_before_first_delegate: firstDelegate < 0 ? names.length : firstDelegate,
    test_runs: testRuns,
    turns_after_last_delegate: lastDelegateTurn < 0 ? 0 : turns.length - lastDelegateTurn - 1,
    prefix_tokens: first ? (first.input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0) + (first.cache_creation_input_tokens ?? 0) : 0,
    cache_write_first_turn: first?.cache_creation_input_tokens ?? 0,
    max_context: maxContext,
    tool_uses: names.length,
    tools_used: names.reduce((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {}),
    bash_writes: bashWrites,
    delegate_calls: names.filter((n) => isCheapag(n) && /__delegate$/.test(n)).length,
    research_calls: names.filter((n) => isCheapag(n) && /__research$/.test(n)).length,
    // subagents (hard_tasks: sonnet); "Task" is the Agent tool's older name
    agent_calls: names.filter((n) => n === "Agent" || n === "Task").length,
    difficulty_hint: hint,
    claude_edits: names.filter(isEdit).length,
    claude_edits_after_delegate: lastDelegate < 0 ? 0 : names.slice(lastDelegate + 1).filter(isEdit).length,
    tool_uses_after_last_cheapag: lastCheapag < 0 ? 0 : names.length - lastCheapag - 1,
    // Claude's own tool calls after the first worker failure, cheapag's tools excluded (what limits.takeover_calls counts)
    takeover_calls: takeoverStart < 0 ? 0 : names.slice(takeoverStart).filter((n) => !isCheapag(n)).length,
    takeover_denied: denied,
    // ticket 30: Claude tried to do a failed step itself instead of handing it to Sonnet / re-ran an OK's tests
    handoff_denied: handoffDenied,
    ok_test_denied: okTestDenied,
  };
}

/** The plugin's skills and hook, pointed at this repo's build: its .mcp.json and hook command run the unpublished npx package, so the server comes from --mcp-config and the hook runs dist/index.js. */
export function preparePlugin(runs) {
  const dir = join(runs, "plugin");
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(root, "plugin"), dir, { recursive: true });
  rmSync(join(dir, ".mcp.json"), { force: true });
  const hooks = join(dir, "hooks", "hooks.json");
  writeFileSync(hooks, readFileSync(hooks, "utf8").replace(/npx -y cheap-agent@[^ ]+ hook/g, `${process.execPath} ${dist} hook`));
  return dir;
}

export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return o;
}

export function fail(msg) { console.error(msg); process.exit(1); }
