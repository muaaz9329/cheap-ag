#!/usr/bin/env node
// The cost ladder (ticket 23.0): one row per quick run (`run.mjs --quick`, suite "swebench-quick") and arm, oldest first,
// with the ratio to the previous run's same arm. Prints it and writes tasks/cost-ladder.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const root = dirname(dirname(here));
const file = join(dirname(here), "results.jsonl");
const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.suite === "swebench-quick") : [];
const sweeps = [...new Map(rows.map((r) => [r.sweep, r.sweep_label])).entries()].sort(([a], [b]) => a.localeCompare(b));

const sum = (rs, k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
const ratio = (now, before) => (before ? `${(now / before).toFixed(2)}x` : "—");
const mins = (ms) => `${(ms / 60_000).toFixed(1)} min`;

const lines = [
  "| # | Label | Arm | Resolved | Claude tokens | Output | Cache writes | Cache reads | Est. $ | Turns | Wall time | Worker $ | $ vs prev | Tokens vs prev |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];
const prev = {};
const summary = [];
sweeps.forEach(([id, label], i) => {
  const rs = rows.filter((r) => r.sweep === id);
  // the whole quick run, sessions and grading, from its start to its last recorded row
  const wall = Math.max(...rs.map((r) => Date.parse(r.ended_at ?? id))) - Date.parse(id);
  const byArm = Map.groupBy(rs, (r) => r.arm);
  for (const [arm, g] of [...byArm.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cost = sum(g, "claude_cost_usd"), tokens = sum(g, "claude_tokens");
    const p = prev[arm];
    lines.push(`| ${i} | ${label} | ${arm} | ${g.filter((r) => r.resolved).length}/${g.length} | ${k(tokens)} | ${k(sum(g, "output_tokens"))} | ${k(sum(g, "cache_creation_tokens"))} | ${k(sum(g, "cache_read_tokens"))} | $${cost.toFixed(2)} | ${sum(g, "num_turns")} | ${mins(wall)} | $${sum(g, "worker_cost_usd").toFixed(3)} | ${ratio(cost, p?.cost)} | ${ratio(tokens, p?.tokens)} |`);
    prev[arm] = { cost, tokens };
  }
  const b = byArm.get("baseline"), c = byArm.get("cheapag");
  if (b && c) summary.push(`- **${i} · ${label}:** cheapag costs ${ratio(sum(c, "claude_cost_usd"), sum(b, "claude_cost_usd"))} of baseline, uses ${ratio(sum(c, "claude_tokens"), sum(b, "claude_tokens"))} of its tokens; resolved ${c.filter((r) => r.resolved).length}/${c.length} vs ${b.filter((r) => r.resolved).length}/${b.length}.`);
});

const md = `# Cost ladder

One row per quick run (\`node bench/swe/run.mjs --quick --label "<lever>"\`, 7 instances in \`bench/swe/quick.json\`) and arm, oldest first. Regenerate with \`node bench/swe/ladder.mjs\`.

**How to read it** (ticket 23.0): on 7 instances a move under **25%** in tokens or dollars is noise. Resolves are a guard: below 6/7 in either arm, run the quick set again before judging. The quick set shows *direction*; the full bench (23.9) shows *size*. "vs prev" compares with the previous row of the same arm.

**Cache warmth confounds rows** (seen on the two S0 reference runs, identical code 4 minutes apart: cost halved, cache writes 141k → 48k and 144k → 19k). A run that starts while the previous run's prompt cache is still warm is cheaper for that reason alone. Compare rows started under the same condition: start each quick run cold (more than an hour after the previous one), or run a fresh reference right before the lever.

${lines.join("\n")}

${summary.join("\n")}
`;
writeFileSync(join(root, "tasks", "cost-ladder.md"), md);
console.log(md);
