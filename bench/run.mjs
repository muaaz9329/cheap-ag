#!/usr/bin/env node
// Benchmark harness: runs each task with `claude -p` in two arms (baseline: no MCP; cheapag: this repo's local build
// plus the plugin's skills) from an identical fresh copy of bench/repo, grades it with the task's hidden tests, and
// appends one JSON line per run to bench/results.jsonl. See bench/README.md.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const root = dirname(here);
const dist = join(root, "dist", "index.js");
const runs = join(here, ".runs");
const opts = parseArgs(process.argv.slice(2));
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).filter((t) => !opts.tasks || opts.tasks.split(",").some((id) => t.id.startsWith(id)));
const arms = (opts.arms ?? "baseline,cheapag").split(",");
const model = opts.model ?? "opus";
const timeoutMs = Number(opts.timeout ?? 25) * 60_000;

if (!existsSync(dist)) fail("build first: npm run build");
mkdirSync(runs, { recursive: true });
const pluginDir = preparePlugin();

for (let n = 1; n <= Number(opts.runs ?? 1); n++) {
  for (const task of tasks) {
    for (const arm of arms) {
      const row = await runOne(task, arm, n);
      if (!row.dry) appendFileSync(join(here, "results.jsonl"), JSON.stringify(row) + "\n");
      console.log(`${row.task} ${row.arm} #${n}: ${row.pass ? "PASS" : "FAIL"} tokens=${row.claude_tokens} out=${row.output_tokens} cost=$${row.claude_cost_usd?.toFixed(3)} worker=$${row.worker_cost_usd.toFixed(4)} ${Math.round(row.duration_ms / 1000)}s delegate=${row.delegate_calls} edits=${row.claude_edits}`);
    }
  }
}

async function runOne(task, arm, n) {
  const dir = join(runs, `${task.id}_${arm}_${n}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(here, "repo"), dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-qm", "base");
  const mcp = join(runs, `${task.id}_${arm}_${n}.mcp.json`);
  const extra = [];
  if (arm.startsWith("cheapag")) {
    writeFileSync(join(dir, "cheapag.json"), JSON.stringify({ test_cmd: "node --test" }));
    const allow = spawnSync(process.execPath, [dist, "allow"], { cwd: dir, encoding: "utf8" });
    if (allow.status !== 0) fail(`cheapag allow failed in ${dir}:\n${allow.stdout}${allow.stderr}`);
    writeFileSync(mcp, JSON.stringify({ mcpServers: { cheapag: { command: process.execPath, args: [dist] } } }));
    extra.push("--plugin-dir", pluginDir);
    // the cheapag-hook arm forces delegation: the plugin's edit guard denies large edits (ticket 20)
    if (arm === "cheapag-hook" && spawnSync(process.execPath, [dist, "hook", "on"], { cwd: dir, encoding: "utf8" }).status !== 0) fail(`cheapag hook on failed in ${dir}`);
  } else {
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  }
  const args = ["-p", task.prompt, "--output-format", "json", "--model", model, "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", mcp, ...extra];
  if (opts.dry) {
    console.log(`[dry] cd ${dir} && claude ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    return { task: task.id, arm, run: n, dry: true, pass: false, claude_tokens: 0, output_tokens: 0, worker_cost_usd: 0, duration_ms: 0, delegate_calls: 0, claude_edits: 0 };
  }
  const started = Date.now();
  const { stdout, stderr, timedOut } = await claude(args, dir);
  writeFileSync(join(dir, ".bench-stdout.json"), stdout);
  if (stderr) writeFileSync(join(dir, ".bench-stderr.txt"), stderr);
  let out = {};
  try { out = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { out = { result: stdout.slice(-2000) }; }
  const usage = out.usage ?? {};
  const files_changed = git(dir, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => !f.startsWith(".bench") && f !== "cheapag.json" && f !== ".cheapag/");
  const grade = gradeRun(task, dir, out.result ?? "");
  const worker = workerMetrics(dir);
  const transcript = transcriptMetrics(out.session_id);
  return {
    task: task.id, kind: task.kind, arm, run: n, model, dir, session_id: out.session_id ?? null, timed_out: timedOut,
    pass: grade.pass, grade_detail: grade.detail,
    input_tokens: usage.input_tokens ?? 0, cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
    claude_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0),
    claude_cost_usd: out.total_cost_usd ?? null, duration_ms: out.duration_ms ?? Date.now() - started, num_turns: out.num_turns ?? null,
    files_changed, ...worker, ...transcript, result_tail: String(out.result ?? "").slice(-600),
  };
}

function claude(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: { ...process.env, CHEAPAG_BENCH: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

/** Hidden tests are copied into test/ after the run and the whole suite is run; research/docs tasks add answer and file checks. */
function gradeRun(task, dir, result) {
  const detail = [];
  const changed = git(dir, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => !f.startsWith(".bench") && f !== "cheapag.json" && f !== ".cheapag/");
  if (task.grade?.unchanged && changed.length) detail.push(`changed files: ${changed.join(", ")}`);
  if (task.grade?.onlyFiles && changed.some((f) => !task.grade.onlyFiles.includes(f))) detail.push(`touched outside ${task.grade.onlyFiles.join(",")}: ${changed.join(", ")}`);
  if (task.grade?.answer && !new RegExp(task.grade.answer, "i").test(result)) detail.push("answer did not match the expected references");
  const hidden = join(here, "tasks", task.id, "hidden");
  if (existsSync(hidden) && readdirSync(hidden).length) {
    for (const f of readdirSync(hidden)) cpSync(join(hidden, f), join(dir, "test", f));
    const r = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) detail.push("tests failed:\n" + (r.stdout + r.stderr).split("\n").filter((l) => /^not ok|^\s+(error|message|expected|actual):|AssertionError/.test(l)).slice(0, 12).join("\n"));
    writeFileSync(join(dir, ".bench-grade.txt"), r.stdout + r.stderr);
  }
  return { pass: detail.length === 0, detail: detail.join(" | ") };
}

/** Worker spend and job outcomes from the run's .cheapag/jobs records. */
function workerMetrics(dir) {
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
function transcriptMetrics(sessionId) {
  const empty = { tool_uses: 0, tools_used: {}, bash_writes: 0, delegate_calls: 0, research_calls: 0, claude_edits: 0, claude_edits_after_delegate: 0, tool_uses_after_last_cheapag: 0 };
  if (!sessionId) return empty;
  const projects = join(homedir(), ".claude", "projects");
  const file = existsSync(projects) ? readdirSync(projects).map((p) => join(projects, p, `${sessionId}.jsonl`)).find(existsSync) : undefined;
  if (!file) return empty;
  const names = [];
  let bashWrites = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const c of e?.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      names.push(c.name);
      // a Bash command that writes files (heredoc, redirect, sed -i, python/node one-liners) edits code without the Edit tools or the hook
      if (c.name === "Bash" && /<<|>>?\s*["']?[\w./-]+|\bsed\s+-i|\btee\b|\bcat\s*>|python3? -c|node -e/.test(String(c.input?.command ?? ""))) bashWrites++;
    }
  }
  const isCheapag = (n) => /^mcp__.*cheapag.*__(delegate|research|reply|jobs|land)$/.test(n);
  const isEdit = (n) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n);
  const lastCheapag = names.map(isCheapag).lastIndexOf(true);
  const lastDelegate = names.map((n) => /__(delegate|reply)$/.test(n) && isCheapag(n)).lastIndexOf(true);
  return {
    tool_uses: names.length,
    tools_used: names.reduce((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {}),
    bash_writes: bashWrites,
    delegate_calls: names.filter((n) => isCheapag(n) && /__delegate$/.test(n)).length,
    research_calls: names.filter((n) => isCheapag(n) && /__research$/.test(n)).length,
    claude_edits: names.filter(isEdit).length,
    claude_edits_after_delegate: lastDelegate < 0 ? 0 : names.slice(lastDelegate + 1).filter(isEdit).length,
    tool_uses_after_last_cheapag: lastCheapag < 0 ? 0 : names.length - lastCheapag - 1,
  };
}

/** The plugin's skills and hook, pointed at this repo's build: its .mcp.json and hook command run the unpublished npx package, so the server comes from --mcp-config and the hook runs dist/index.js. */
function preparePlugin() {
  const dir = join(runs, "plugin");
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(root, "plugin"), dir, { recursive: true });
  rmSync(join(dir, ".mcp.json"), { force: true });
  const hooks = join(dir, "hooks", "hooks.json");
  writeFileSync(hooks, readFileSync(hooks, "utf8").replace(/npx -y cheap-agent@[^ ]+ hook guard/, `${process.execPath} ${dist} hook guard`));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return o;
}

function fail(msg) { console.error(msg); process.exit(1); }
