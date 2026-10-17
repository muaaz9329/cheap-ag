#!/usr/bin/env node
// Benchmark v2: SWE-bench Verified instances (bench/swe/instances.json), Claude Code alone vs Claude + Cheap Agent.
// The agent runs on the host in a git worktree at the instance's base commit; tests run in the instance's SWE-bench image
// through ./swebench-test.sh; the patch is graded by the official harness. One JSON line per session goes to
// bench/results.jsonl (shown by bench/dashboard.mjs). See bench/swe/README.md.
import { spawnSync } from "node:child_process";
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
const PROMPT_TAIL = "Fix this in the repository at the current directory. Run the relevant tests with `./swebench-test.sh <test args>` (it runs them in the project's own environment). Do not commit.";
const HELPERS = ["swebench-test.sh", "cheapag.json"]; // ours, never part of the patch
const dataset = new Map(readFileSync(join(deps, "verified.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.instance_id, r]));
const all = JSON.parse(readFileSync(join(here, "instances.json"), "utf8"));

if (!existsSync(dist)) fail("build first: npm run build");
mkdirSync(runsDir, { recursive: true });
const pluginDir = preparePlugin(runsDir);
const sweep = { id: new Date().toISOString(), label: opts.label ?? `swebench-verified · ${MODEL}${opts.long ? " · long session" : ""}` };

if (opts.long) await longSessions();
else await singles();

/** One fresh session per instance and arm; the strata are interleaved so a budget stop still leaves every difficulty covered. */
async function singles() {
  const n = Number(opts.run ?? 1);
  const chosen = all.filter((i) => !opts.instances || opts.instances.split(",").includes(i.instance_id));
  const strata = Map.groupBy(chosen, (i) => i.difficulty);
  const order = [];
  for (let k = 0; order.length < chosen.length; k++) for (const list of strata.values()) if (list[k]) order.push(list[k]);
  for (const inst of order) {
    for (const arm of arms) {
      overBudget();
      const dir = checkout(inst, `${inst.instance_id}_${arm}_${n}`, arm);
      const row = await session(inst, arm, dir, [problem(inst)]);
      record({ ...row, run: n, ...(await grade(inst, arm, `r${n}`, dir)) });
    }
  }
}

/**
 * Long session: the long_session instances (django, increasing difficulty) one after another in ONE Claude session per arm:
 * the checkout is reset to each instance's base commit and the session resumed with the next problem statement.
 */
async function longSessions() {
  const n = Number(opts.run ?? 1);
  const seq = all.filter((i) => i.long_session).sort((a, b) => a.long_session - b.long_session);
  for (const arm of arms) {
    overBudget();
    const dir = checkout(seq[0], `long_${arm}_${n}`, arm);
    let sessionId;
    for (const [k, inst] of seq.entries()) {
      if (k) reset(dir, inst, arm);
      const row = await session(inst, arm, dir, [problem(inst)], sessionId);
      sessionId = row.session_id ?? sessionId;
      record({ ...row, run: n, long_session: k + 1, ...(await grade(inst, arm, `long${n}-${k + 1}`, dir)) });
    }
  }
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
  writeFileSync(join(dir, "cheapag.json"), JSON.stringify({ allow_commands: ["./swebench-test.sh"] }));
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
    "--strict-mcp-config", "--mcp-config", mcp, "--max-turns", "80", "--max-budget-usd", "6",
    ...(cheap ? ["--plugin-dir", pluginDir] : []), ...(resume ? ["--resume", resume] : []),
  ];
  if (opts.dry) {
    console.log(`[dry] cd ${dir} && claude ${args.map((a) => (/[\s'"`]/.test(a) ? JSON.stringify(a.slice(0, 80) + "…") : a)).join(" ")}`);
    return { dry: true };
  }
  const jobsBefore = jobIds(dir);
  const started = Date.now();
  const { stdout, stderr, timedOut } = await claude(args, dir, timeoutMs);
  const tag = `${inst.instance_id}`;
  writeFileSync(join(dir, `.bench-stdout-${tag}.json`), stdout);
  if (stderr) writeFileSync(join(dir, `.bench-stderr-${tag}.txt`), stderr);
  let out = {};
  try { out = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { out = { result: stdout.slice(-2000) }; }
  const usage = out.usage ?? {};
  const worker = jobMetrics(dir, jobsBefore);
  return {
    suite: "swebench-verified", task: inst.instance_id, instance_id: inst.instance_id, kind: inst.difficulty, difficulty: inst.difficulty,
    repo: inst.repo, arm, model: MODEL, dir, session_id: out.session_id ?? null, timed_out: timedOut,
    subtype: out.subtype ?? null, budget_hit: out.subtype === "error_max_budget_usd", turns_hit: out.subtype === "error_max_turns",
    input_tokens: usage.input_tokens ?? 0, cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
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
    worker_redos: fresh.reduce((s, j) => s + (j.redo ?? 0), 0), escalations: fresh.filter((j) => j.models?.escalated).length,
  };
}

/** The checkout's change against the base commit (helpers and Cheap Agent state excluded), graded by the official harness. */
async function grade(inst, arm, label, dir) {
  if (opts.dry) return {};
  git(dir, "add", "-A");
  const patch = git(dir, "diff", "--cached", inst.base_commit, "--", ".", ...HELPERS.map((h) => `:(exclude)${h}`), ":(exclude).cheapag", ":(exclude).plan");
  git(dir, "reset", "-q");
  const pred = { instance_id: inst.instance_id, model_name_or_path: `${arm}/${MODEL}`, model_patch: patch };
  appendFileSync(join(here, `preds-${arm}-${label.replace(/-\d+$/, "")}.jsonl`), JSON.stringify(pred) + "\n");
  if (!patch.trim()) return { resolved: false, patch_lines: 0, grade_detail: "empty patch" };
  const runId = `v2-${arm}-${label}-${inst.instance_id}`;
  const file = join(runsDir, `${runId}.pred.jsonl`);
  writeFileSync(file, JSON.stringify(pred) + "\n");
  const r = spawnSync(join(venvBin, "swebench"), ["eval", "verified", "-p", file, "-i", inst.instance_id, "--run-id", runId, "-j", "1"], { cwd: here, encoding: "utf8", env: { ...process.env, PATH: `${venvBin}:${process.env.PATH}` } });
  let results = {};
  try { results = JSON.parse(readFileSync(join(here, "logs", "evaluation", runId, "results.json"), "utf8")); } catch { /* reported below */ }
  const resolved = (results.resolved_ids ?? []).includes(inst.instance_id);
  const errored = !results.completed_ids?.includes(inst.instance_id);
  return {
    resolved, grade_run_id: runId, patch_lines: patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
    grade_detail: errored ? `harness error: ${(r.stdout + r.stderr).split("\n").filter((l) => /Error/.test(l)).slice(0, 3).join(" | ")}` : resolved ? "" : "unresolved",
    pass: resolved, // the dashboard's pass column
  };
}

function record(row) {
  if (opts.dry) return;
  appendFileSync(join(bench, "results.jsonl"), JSON.stringify({ sweep: sweep.id, sweep_label: sweep.label, ...row }) + "\n");
  spawnSync(process.execPath, [join(bench, "dashboard.mjs")], { stdio: "ignore" });
  console.log(`${row.instance_id} ${row.arm}${row.long_session ? ` long#${row.long_session}` : ""} r${row.run}: ${row.resolved ? "RESOLVED" : "unresolved"} tokens=${row.claude_tokens} out=${row.output_tokens} cost=$${row.claude_cost_usd?.toFixed(2)} turns=${row.num_turns} max_ctx=${row.max_context} worker=$${row.worker_cost_usd.toFixed(4)} delegate=${row.delegate_calls} ${Math.round(row.duration_ms / 60000)}min ${row.subtype ?? ""}`);
}

/** Stops the sweep once v2's running spend passes 80% of either budget (all v2 rows so far, every invocation). */
function overBudget() {
  if (opts.dry || !existsSync(join(bench, "results.jsonl"))) return;
  const rows = readFileSync(join(bench, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.suite === "swebench-verified");
  const claudeUsd = rows.reduce((s, r) => s + (r.claude_cost_usd ?? 0), 0), workerUsd = rows.reduce((s, r) => s + (r.worker_cost_usd ?? 0), 0);
  if (claudeUsd > 0.8 * CLAUDE_BUDGET || workerUsd > 0.8 * WORKER_BUDGET) {
    fail(`budget stop: Claude $${claudeUsd.toFixed(2)} of $${CLAUDE_BUDGET}, worker $${workerUsd.toFixed(2)} of $${WORKER_BUDGET} (80% guard)`);
  }
}
