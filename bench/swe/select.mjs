#!/usr/bin/env node
// Picks the v2 suite from SWE-bench Verified (bench/swe/.deps/verified.jsonl) and freezes it in bench/swe/instances.json:
// 8 × "<15 min fix", 10 × "15 min - 1 hour", 6 × "1-4 hours", deterministic (lowest sha1 of the id first), about half django
// (its share of the dataset) and the rest spread across the other repos. Four django picks of increasing difficulty
// also form the long-session scenario. Each entry carries its image and the test command from the task's eval.sh.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const deps = join(here, ".deps");
const rows = readFileSync(join(deps, "verified.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const STRATA = [["<15 min fix", 8], ["15 min - 1 hour", 10], ["1-4 hours", 6]];
const skip = new Set(process.argv.slice(2)); // instance ids to leave out (e.g. gold fails on this machine)
const hash = (id) => createHash("sha1").update(id).digest("hex");

const picked = [];
for (const [difficulty, n] of STRATA) {
  const pool = rows.filter((r) => r.difficulty === difficulty && !skip.has(r.instance_id)).sort((a, b) => hash(a.instance_id).localeCompare(hash(b.instance_id)));
  const byRepo = Map.groupBy(pool, (r) => r.repo);
  const others = [...byRepo.keys()].filter((r) => r !== "django/django").sort((a, b) => byRepo.get(b).length - byRepo.get(a).length);
  const take = (repo) => byRepo.get(repo).shift();
  const out = Array.from({ length: Math.ceil(n / 2) }, () => take("django/django"));
  for (let i = 0; out.length < n; i++) {
    const repo = others[i % others.length];
    if (byRepo.get(repo).length) out.push(take(repo));
  }
  picked.push(...out);
}

const django = (d) => picked.filter((r) => r.repo === "django/django" && r.difficulty === d);
const long = [django("<15 min fix")[0], django("15 min - 1 hour")[0], django("15 min - 1 hour")[1], django("1-4 hours")[0]].map((r) => r.instance_id);

const instances = picked.map((r) => {
  const task = join(deps, "swe-bench-tasks", "tasks", r.instance_id);
  const image = readFileSync(join(task, "task.yaml"), "utf8").match(/^image: (.+)$/m)[1].trim();
  const evalSh = readFileSync(join(task, "eval.sh"), "utf8");
  return {
    instance_id: r.instance_id, repo: r.repo, difficulty: r.difficulty, base_commit: r.base_commit,
    image, image_source: "x86_64, pulled, run under Rosetta (colima --vz-rosetta)",
    test_cmd: testCommand(evalSh), long_session: long.indexOf(r.instance_id) + 1 || null,
  };
});
if (instances.some((i) => !existsSync(join(deps, "swe-bench-tasks", "tasks", i.instance_id)))) throw new Error("task missing from swe-bench-tasks");
writeFileSync(join(here, "instances.json"), JSON.stringify(instances, null, 2) + "\n");
for (const i of instances) console.log(i.difficulty.padEnd(16), i.instance_id.padEnd(40), i.long_session ?? "", i.test_cmd);

/** The test line of eval.sh without the instance's own test ids (trailing non-flag arguments), so the agent picks its own. */
function testCommand(evalSh) {
  const line = evalSh.split("\n").map((l, i, all) => all[i - 1]?.includes(">>>>> Start Test Output") && l).find(Boolean);
  const words = line.trim().split(/\s+/);
  while (words.length > 1 && !words.at(-1).startsWith("-") && !/^\d+$/.test(words.at(-1))) words.pop();
  return words.join(" ");
}
