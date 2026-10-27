#!/usr/bin/env node
// Benchmark v2: SWE-bench Verified instances (bench/swe/instances.json), Claude Code alone vs Claude + Cheap Agent.
// The agent runs on the host in a git worktree at the instance's base commit; tests run in the instance's SWE-bench image
// through ./swebench-test.sh; the patch is graded by the official harness. One JSON line per session goes to
// bench/results.jsonl (shown by bench/dashboard.mjs). See bench/swe/README.md.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claude, dist, fail, git, parseArgs, preparePlugin, transcriptMetrics, workerMetrics } from "../lib.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const bench = dirname(here);
const deps = join(here, ".deps");
const runsDir = join(here, ".runs");
const venvBin = join(deps, "venv", "bin");
const opts = parseArgs(process.argv.slice(2));
const MODEL = "claude-opus-5-5";
const arms = (opts.arms ?? "baseline,cheapag").split(",");
const timeoutMs = Number(opts.timeout ?? 60) * 60_000;
// spend guards (ticket 21.1): stop once the running totals pass 80% of either budget
const CLAUDE_BUDGET = Number(opts.budget ?? 100), WORKER_BUDGET = Number(opts["worker-budget"] ?? 5);
// S1 (ticket 23.1), on by default since: no user plugins/skills/settings, per-machine prompt sections moved out of the
// cached prefix, no git-instructions boilerplate; the baseline also drops skills (cheapag needs its plugin's). --no-lean: as runs 1-2
const LEAN = !opts["no-lean"];
// --worker-model <provider/id> (ticket 25): the cheapag arm's implement model, written to each checkout's cheapag.json
const WORKER_MODEL = opts["worker-model"] ?? null;
// --medium-model, --hard-model <provider/id>, --hard-tasks <delegate|self|sonnet> (ticket 26): the tier models and the hard-task rule, likewise
const MEDIUM_MODEL = opts["medium-model"] ?? null, HARD_MODEL = opts["hard-model"] ?? null, HARD_TASKS = opts["hard-tasks"] ?? null;
if (HARD_TASKS && !["delegate", "self", "sonnet"].includes(HARD_TASKS)) fail("--hard-tasks must be delegate, self or sonnet");
// S2 (ticket 23.2), on by default since: an arm's sessions back to back on the 5-minute cache TTL (writes $5/M instead of
// $8/M; no gap between sessions comes near 5 minutes). --no-warm: interleaved arms, Claude Code's default 1h TTL
const WARM = !opts["no-warm"];
// S3 (ticket 23.3), on by default since: 50 turns at most, and the baseline gets cheapag's verification rule verbatim (cheapag
// carries it in its instructions), so only delegation differs between the arms. --no-verify-rule: 80 turns, no rule
const VERIFY = !opts["no-verify-rule"];
const { VERIFY_RULE } = await import(join(dirname(dist), "rules.js"));
const CLAUDE_VERSION = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim().split(" ")[0];
const PROMPT_TAIL = "Fix this in the repository at the current directory. Run the relevant tests with `./swebench-test.sh <test args>` (it runs them in the project's own environment). Do not commit.";
const HELPERS = ["swebench-test.sh", "cheapag.json"]; // ours, never part of the patch
const dataset = new Map(readFileSync(join(deps, "verified.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.instance_id, r]));
const all = JSON.parse(readFileSync(join(here, "instances.json"), "utf8"));

if (!existsSync(dist)) fail("build first: npm run build");
mkdirSync(runsDir, { recursive: true });
const pluginDir = preparePlugin(runsDir);
const sweep = { id: new Date().toISOString(), label: opts.label ?? `swebench-verified · ${MODEL}${opts.long ? " · long session" : ""}` };
// --quick (ticket 23.0): the fixed 7-instance subset in quick.json, one run, its own suite, so each cost lever is checked in ~15 min
const SUITE = opts.quick ? "swebench-quick" : "swebench-verified";
if (opts.quick) {
  if (!opts.label) fail("--quick needs --label, e.g. --label \"S1 stable prefix\" (it names the ladder row)");
  const quick = JSON.parse(readFileSync(join(here, "quick.json"), "utf8"));
  opts.instances = quick.join(",");
}

if (opts.long) await longSessions();
else await singles();

/** One fresh session per instance and arm; the strata are interleaved so a budget stop still leaves every difficulty covered. */
async function singles() {
  const n = Number(opts.run ?? 1);
  // a quick run's grading ids are unique per sweep (the harness keeps each run's logs); its checkouts are reused
  const tag = opts.quick ? `q${sweep.id.replace(/\D/g, "").slice(0, 14)}` : `r${n}`;
  const pending = [];
  const chosen = all.filter((i) => !opts.instances || opts.instances.split(",").includes(i.instance_id));
  const strata = Map.groupBy(chosen, (i) => i.difficulty);
  const order = [];
  for (let k = 0; order.length < chosen.length; k++) for (const list of strata.values()) if (list[k]) order.push(list[k]);
  // S2 (ticket 23.2): every checkout first, then each arm's sessions back to back, so the cached prefix stays warm
  const dirs = new Map();
  if (WARM && !opts.dry) for (const arm of arms) for (const inst of order) dirs.set(`${inst.instance_id} ${arm}`, checkout(inst, `${inst.instance_id}_${arm}_${opts.quick ? "quick" : n}`, arm));
  const plan = WARM ? arms.flatMap((arm) => order.map((inst) => [inst, arm])) : order.flatMap((inst) => arms.map((arm) => [inst, arm]));
  for (const [inst, arm] of plan) {
    {
      overBudget();
      const dir = dirs.get(`${inst.instance_id} ${arm}`) ?? checkout(inst, `${inst.instance_id}_${arm}_${opts.quick ? "quick" : n}`, arm);
      const row = await session(inst, arm, dir, [problem(inst)]);
      // a quick run grades everything at the end, in parallel: one at a time would add ~45 s per session
      if (opts.quick) pending.push({ arm, row: { ...row, run: n }, pred: opts.dry ? null : predict(inst, arm, tag, dir) });
      else record({ ...row, run: n, ...(await grade(inst, arm, tag, dir)) });
    }
  }
  if (opts.dry || !pending.length) return;
  const grades = await Promise.all(arms.map((arm) => gradeBatch(arm, `v2-${arm}-${tag}`, pending.filter((p) => p.arm === arm).map((p) => p.pred))));
  for (const p of pending) record({ ...p.row, ...grades[arms.indexOf(p.arm)][p.row.instance_id] });
}

/**
 * Long session: the long_session instances (django, increasing difficulty) one after another in ONE Claude session per arm:
 * the checkout is reset to each instance's base commit and the session resumed with the next problem statement.
 */
async function longSessions() {
  const n = Number(opts.run ?? 1);
  // --instances sets the sequence in its own order (ticket 24.3: the quick set's django instances)
  const seq = opts.instances
    ? opts.instances.split(",").map((id) => all.find((i) => i.instance_id === id) ?? fail(`unknown instance ${id}`))
    : all.filter((i) => i.long_session).sort((a, b) => a.long_session - b.long_session);
  for (const arm of arms) {
    overBudget();
    const dir = checkout(seq[0], `long_${arm}_${n}`, arm);
    let sessionId, before;
    for (const [k, inst] of seq.entries()) {
      if (k) reset(dir, inst, arm);
      const row = await session(inst, arm, dir, [problem(inst)], sessionId);
      sessionId = row.session_id ?? sessionId;
      record({ ...row, ...sinceLast(row, before), run: n, long_session: k + 1, ...(await grade(inst, arm, `long${n}-${k + 1}`, dir)) });
      before = row;
    }
  }
}

/** A resumed session reports its cost and the transcript's counts for the whole session so far; keep this task's share. */
const SESSION_TOTALS = ["claude_cost_usd", "tool_uses", "delegate_calls", "research_calls", "agent_calls", "claude_edits", "test_runs", "bash_writes"];
function sinceLast(row, before) {
  return before ? Object.fromEntries(SESSION_TOTALS.map((f) => [f, (row[f] ?? 0) - (before[f] ?? 0)])) : {};
}

/** A worktree of the instance's repo at its base commit, with the test script and, for cheapag, its config and consent. */
function checkout(inst, name, arm) {
  const repo = repoFor(inst);
  const dir = join(runsDir, name);
  spawnSync("git", ["-C", repo, "worktree", "remove", "--force", dir]);
  spawnSync("git", ["-C", repo, "worktree", "prune"]);
  git(repo, "worktree", "add", "-q", "--detach", dir, inst.base_commit);
  setup(dir, inst, arm);
  return dir;
}

/**
 * The instance's repository, copied out of its image (/testbed: full history, base commit plus an empty "SWE-bench"
 * commit), so no clone from GitHub is needed. Only its .git is kept; runs are worktrees of it.
 */
function repoFor(inst) {
  const repo = join(here, ".repos", inst.instance_id);
  if (existsSync(join(repo, ".git"))) return repo;
  mkdirSync(repo, { recursive: true });
  const cid = spawnSync("docker", ["create", "--platform", "linux/amd64", inst.image], { encoding: "utf8" }).stdout.trim();
  if (!cid) fail(`docker create ${inst.image} failed (image pulled?)`);
  const cp = spawnSync("docker", ["cp", "-q", `${cid}:/testbed/.git`, join(repo, ".git")], { encoding: "utf8" });
  spawnSync("docker", ["rm", "-f", cid]);
  if (cp.status !== 0) fail(`copying /testbed/.git out of ${inst.image} failed: ${cp.stderr}`);
  git(repo, "config", "core.bare", "false");
  // ours and Cheap Agent's files stay out of `git status` noise and of every patch
  writeFileSync(join(repo, ".git", "info", "exclude"), [".cheapag/", ".plan/", ".bench-*", ""].join("\n"));
  return repo;
}

/** Back to the next instance's base commit for a long session; Cheap Agent's state (.cheapag/, consent) is kept. */
function reset(dir, inst, arm) {
  git(dir, "reset", "-q", "--hard");
  git(dir, "clean", "-qfd", "-e", ".cheapag/", "-e", ".plan/");
  // a later instance's base commit may be newer than the first image's history: fetch it from that instance's copy
  if (spawnSync("git", ["-C", dir, "cat-file", "-e", `${inst.base_commit}^{commit}`]).status !== 0) git(dir, "fetch", "-q", repoFor(inst), "HEAD");
  git(dir, "checkout", "-q", "--detach", inst.base_commit);
  setup(dir, inst, arm);
}

function setup(dir, inst, arm) {
  writeFileSync(join(dir, "swebench-test.sh"), testScript(inst));
  chmodSync(join(dir, "swebench-test.sh"), 0o755);
  if (!arm.startsWith("cheapag")) return;
  // no test_cmd: with no arguments the script runs the whole suite (an hour+ under Rosetta); plans name their tests
  const models = { ...(WORKER_MODEL && { implement: WORKER_MODEL }), ...(MEDIUM_MODEL && { medium: MEDIUM_MODEL }), ...(HARD_MODEL && { hard: HARD_MODEL }) };
  writeFileSync(join(dir, "cheapag.json"), JSON.stringify({ allow_commands: ["./swebench-test.sh"], ...(Object.keys(models).length && { models }), ...(HARD_TASKS && { hard_tasks: HARD_TASKS }) }));
  const allow = spawnSync(process.execPath, [dist, "allow"], { cwd: dir, encoding: "utf8" });
  if (allow.status !== 0) fail(`cheapag allow failed in ${dir}:\n${allow.stdout}${allow.stderr}`);
}

/**
 * Runs the repo's tests in the instance image on this checkout: changed and new files are streamed over /testbed (the
 * image's copy at the base commit, with its build artifacts), deleted ones removed, then the eval.sh test command runs
 * with the given test arguments. Works from any worktree of the checkout, Cheap Agent's included.
 */
function testScript(inst) {
  const inner = [
    "tar -xf - -C /testbed --warning=no-unknown-keyword || exit 1",
    'while IFS= read -r f; do [ -n "$f" ] && rm -f "/testbed/$f"; done <<< "$SWEB_DELETED"',
    'args=("$@"); set --', // `source` would hand the test arguments to activate
    "source /opt/miniconda3/bin/activate && conda activate testbed",
    "cd /testbed",
    'eval "$SWEB_CMD \\"\\${args[@]}\\""',
  ].join("\n");
  return `#!/usr/bin/env bash
# Runs ${inst.repo}'s tests in the SWE-bench image for ${inst.instance_id}, on this checkout's changes. Usage: ./swebench-test.sh <test args>
set -o pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
export SWEB_CMD=${shq(inst.test_cmd)}
export SWEB_DELETED="$(git diff --name-only --diff-filter=D HEAD)"
{ git diff -z --name-only --diff-filter=d HEAD; git ls-files -z --others --exclude-standard; } |
  COPYFILE_DISABLE=1 tar -cf - --no-xattrs --null -T - --exclude swebench-test.sh --exclude cheapag.json |
  docker run --rm -i --platform linux/amd64 -e SWEB_CMD -e SWEB_DELETED ${inst.image} bash -c ${shq(inner)} bash "$@"
`;
}

function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }
/** Only the issue text: never hints_text, test_patch or the FAIL_TO_PASS tests. */
function problem(inst) { return `${dataset.get(inst.instance_id).problem_statement.trim()}\n\n${PROMPT_TAIL}`; }

async function session(inst, arm, dir, [prompt], resume) {
  const mcp = join(runsDir, `${dir.split("/").at(-1)}.mcp.json`);
  const cheap = arm.startsWith("cheapag");
  writeFileSync(mcp, JSON.stringify({ mcpServers: cheap ? { cheapag: { command: process.execPath, args: [dist] } } : {} }));
  const args = [
    "-p", prompt, "--output-format", "json", "--model", MODEL, "--dangerously-skip-permissions",
    "--strict-mcp-config", "--mcp-config", mcp, "--max-turns", VERIFY ? "50" : "80", "--max-budget-usd", "6",
    ...(VERIFY && !cheap ? ["--append-system-prompt", VERIFY_RULE] : []),
    ...(LEAN ? ["--setting-sources", "project", "--exclude-dynamic-system-prompt-sections", "--settings", JSON.stringify({ includeGitInstructions: false })] : []),
    ...(cheap ? ["--plugin-dir", pluginDir] : LEAN ? ["--disable-slash-commands"] : []), ...(resume ? ["--resume", resume] : []),
  ];
  if (opts.dry) {
    console.log(`[dry] cd ${dir} && claude ${args.map((a) => (/[\s'"`]/.test(a) ? JSON.stringify(a.slice(0, 80) + "…") : a)).join(" ")}`);
    return { dry: true };
  }
  const jobsBefore = jobIds(dir);
  const started = Date.now();
  const { stdout, stderr, timedOut } = await claude(args, dir, timeoutMs, WARM ? { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" } : {});
  const tag = `${inst.instance_id}`;
  writeFileSync(join(dir, `.bench-stdout-${tag}.json`), stdout);
  if (stderr) writeFileSync(join(dir, `.bench-stderr-${tag}.txt`), stderr);
  let out = {};
  try { out = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { out = { result: stdout.slice(-2000) }; }
  const usage = out.usage ?? {};
  const worker = jobMetrics(dir, jobsBefore);
  return {
    suite: SUITE, task: inst.instance_id, instance_id: inst.instance_id, kind: inst.difficulty, difficulty: inst.difficulty,
    repo: inst.repo, arm, model: MODEL, worker_model: cheap ? WORKER_MODEL : null,
    medium_model: cheap ? MEDIUM_MODEL : null, hard_model: cheap ? HARD_MODEL : null, hard_tasks: cheap ? HARD_TASKS : null, claude_version: CLAUDE_VERSION, lean: LEAN, warm: WARM, verify_rule: VERIFY, dir, session_id: out.session_id ?? null, timed_out: timedOut,
    subtype: out.subtype ?? null, budget_hit: out.subtype === "error_max_budget_usd", turns_hit: out.subtype === "error_max_turns",
    input_tokens: usage.input_tokens ?? 0, cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0, ...cacheTtl(usage.cache_creation),
    claude_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0),
    claude_cost_usd: out.total_cost_usd ?? null, duration_ms: out.duration_ms ?? Date.now() - started, num_turns: out.num_turns ?? null,
    ...worker, ...transcriptMetrics(out.session_id), result_tail: String(out.result ?? "").slice(-600),
  };
}

function jobIds(dir) { return existsSync(join(dir, ".cheapag", "jobs")) ? readdirSync(join(dir, ".cheapag", "jobs")).filter((id) => id.startsWith("j")) : []; }

/** Worker metrics for the jobs this session started (a long session's earlier jobs are left out). */
function jobMetrics(dir, before) {
  const all = workerMetrics(dir);
  const fresh = jobIds(dir).filter((id) => !before.includes(id)).map((id) => join(dir, ".cheapag", "jobs", id, "result.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
  const statuses = {};
  for (const j of fresh) statuses[j.status] = (statuses[j.status] ?? 0) + 1;
  return {
    ...all,
    worker_cost_usd: fresh.reduce((s, j) => s + (j.usage?.costUsd ?? 0), 0), worker_turns: fresh.reduce((s, j) => s + (j.usage?.turns ?? 0), 0),
    jobs: fresh.length, job_statuses: statuses, worker_fails: fresh.filter((j) => j.status === "FAIL").length,
    // the server's check of the worker's reproduction test, last job wins (ticket 24.1)
    repro: fresh.map((j) => j.repro).filter(Boolean).at(-1) ?? null,
    worker_redos: fresh.reduce((s, j) => s + (j.redo ?? 0), 0), escalations: fresh.filter((j) => j.models?.escalated).length,
  };
}

/** The checkout's change against the base commit (helpers and Cheap Agent state excluded), graded by the official harness. */
async function grade(inst, arm, label, dir) {
  if (opts.dry) return {};
  const pred = predict(inst, arm, label, dir);
  return (await gradeBatch(arm, `v2-${arm}-${label}-${inst.instance_id}`, [pred]))[inst.instance_id];
}

/** The prediction for one session: its patch, also appended to the arm's predictions file. */
function predict(inst, arm, label, dir) {
  git(dir, "add", "-A");
  const patch = git(dir, "diff", "--cached", inst.base_commit, "--", ".", ...HELPERS.map((h) => `:(exclude)${h}`), ":(exclude).cheapag", ":(exclude).plan");
  git(dir, "reset", "-q");
  const pred = { instance_id: inst.instance_id, model_name_or_path: `${arm}/${MODEL}`, model_patch: patch };
  appendFileSync(join(here, `preds-${arm}-${label.replace(/-\d+$/, "")}.jsonl`), JSON.stringify(pred) + "\n");
  return pred;
}

/** Grades predictions in one harness run (instances in parallel); returns each instance's grade fields. */
async function gradeBatch(arm, runId, preds) {
  const out = {};
  const graded = preds.filter((p) => p.model_patch.trim());
  for (const p of preds) if (!p.model_patch.trim()) out[p.instance_id] = { resolved: false, pass: false, patch_lines: 0, grade_detail: "empty patch" };
  if (!graded.length) return out;
  const file = join(runsDir, `${runId}.pred.jsonl`);
  writeFileSync(file, graded.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const args = ["eval", "verified", "-p", file, ...graded.flatMap((p) => ["-i", p.instance_id]), "--run-id", runId, "-j", String(Math.min(graded.length, 7))];
  const { stdout, stderr } = await new Promise((resolve) => {
    const child = spawn(join(venvBin, "swebench"), args, { cwd: here, env: { ...process.env, PATH: `${venvBin}:${process.env.PATH}` } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => resolve({ stdout, stderr }));
  });
  let results = {};
  try { results = JSON.parse(readFileSync(join(here, "logs", "evaluation", runId, "results.json"), "utf8")); } catch { /* reported below */ }
  for (const p of graded) {
    const resolved = (results.resolved_ids ?? []).includes(p.instance_id);
    const errored = !results.completed_ids?.includes(p.instance_id);
    out[p.instance_id] = {
      resolved, grade_run_id: runId, patch_lines: p.model_patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
      grade_detail: errored ? `harness error: ${(stdout + stderr).split("\n").filter((l) => /Error/.test(l)).slice(0, 3).join(" | ")}` : resolved ? "" : "unresolved",
      pass: resolved, // the dashboard's pass column
    };
  }
  return out;
}

function record(row) {
  if (opts.dry) return;
  appendFileSync(join(bench, "results.jsonl"), JSON.stringify({ sweep: sweep.id, sweep_label: sweep.label, ...row, ended_at: new Date().toISOString() }) + "\n");
  spawnSync(process.execPath, [join(bench, "dashboard.mjs")], { stdio: "ignore" });
  console.log(`${row.instance_id} ${row.arm}${row.long_session ? ` long#${row.long_session}` : ""} r${row.run}: ${row.resolved ? "RESOLVED" : "unresolved"} tokens=${row.claude_tokens} out=${row.output_tokens} cost=$${row.claude_cost_usd?.toFixed(2)} turns=${row.num_turns} max_ctx=${row.max_context} worker=$${row.worker_cost_usd.toFixed(4)} delegate=${row.delegate_calls} ${Math.round(row.duration_ms / 60000)}min ${row.subtype ?? ""}`);
}

/** Stops the sweep once v2's running spend passes 80% of either budget (all v2 rows so far, every invocation). */
function overBudget() {
  if (opts.dry || !existsSync(join(bench, "results.jsonl"))) return;
  const rows = readFileSync(join(bench, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.suite?.startsWith("swebench")); // the full and quick benches share the budget
  const claudeUsd = rows.reduce((s, r) => s + (r.claude_cost_usd ?? 0), 0), workerUsd = rows.reduce((s, r) => s + (r.worker_cost_usd ?? 0), 0);
  if (claudeUsd > 0.8 * CLAUDE_BUDGET || workerUsd > 0.8 * WORKER_BUDGET) {
    fail(`budget stop: Claude $${claudeUsd.toFixed(2)} of $${CLAUDE_BUDGET}, worker $${workerUsd.toFixed(2)} of $${WORKER_BUDGET} (80% guard)`);
  }
}

/** Which TTL the session's cache writes used (usage.cache_creation): "5m", "1h", "mixed" or null when nothing was written. */
function cacheTtl(c = {}) {
  const m5 = c.ephemeral_5m_input_tokens ?? 0, h1 = c.ephemeral_1h_input_tokens ?? 0;
  return { cache_write_5m: m5, cache_write_1h: h1, cache_ttl: m5 && h1 ? "mixed" : m5 ? "5m" : h1 ? "1h" : null };
}
