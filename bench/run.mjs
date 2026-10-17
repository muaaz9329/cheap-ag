#!/usr/bin/env node
// Benchmark harness: runs each task with `claude -p` in two arms (baseline: no MCP; cheapag: this repo's local build
// plus the plugin's skills) from an identical fresh copy of bench/repo, grades it with the task's hidden tests, and
// appends one JSON line per run to bench/results.jsonl. See bench/README.md.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claude, fail, git, parseArgs, preparePlugin, transcriptMetrics, workerMetrics } from "./lib.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const root = dirname(here);
const dist = join(root, "dist", "index.js");
const runs = join(here, ".runs");
const opts = parseArgs(process.argv.slice(2));
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).filter((t) => !opts.tasks || opts.tasks.split(",").some((id) => t.id.startsWith(id)));
const arms = (opts.arms ?? "baseline,cheapag").split(",");
const model = opts.model ?? "opus";
const timeoutMs = Number(opts.timeout ?? 25) * 60_000;
// one id per invocation: the dashboard groups rows into benchmark runs by it
const sweep = { id: new Date().toISOString(), label: opts.label ?? `${model} · ${arms.join("+")}` };

if (!existsSync(dist)) fail("build first: npm run build");
mkdirSync(runs, { recursive: true });
const pluginDir = preparePlugin(runs);

for (let n = 1; n <= Number(opts.runs ?? 1); n++) {
  for (const task of tasks) {
    for (const arm of arms) {
      const row = await runOne(task, arm, n);
      if (!row.dry) {
        appendFileSync(join(here, "results.jsonl"), JSON.stringify({ sweep: sweep.id, sweep_label: sweep.label, ...row }) + "\n");
        spawnSync(process.execPath, [join(here, "dashboard.mjs")], { stdio: "ignore" }); // keep bench/dashboard.html current, run by run
      }
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
  const { stdout, stderr, timedOut } = await claude(args, dir, timeoutMs);
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

