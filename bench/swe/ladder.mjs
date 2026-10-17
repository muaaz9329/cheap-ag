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

// what a row's numbers mean beyond the table, by label prefix (written once the run is read)
const NOTES = {
  S4: "S4 vs S3: the first lever that is cheapag's own, and the largest so far. cheapag sessions went to exactly 2 turns each (delegate, then answer) with 0 tool calls before delegating (was ~0.3), so its Claude tokens fell 475k → 277k (−42%) and its no-cache $ 2.01 → 1.21 (−40%); estimated $ 0.57 → 0.49. Worker spend rose ($0.05 → $0.09) as the worker explores instead. The baseline (control) stayed flat (+4% tokens). All 14 resolved. research was not called once on this quick set, so the scout brief and delegate brief= are untested live; they matter when Claude needs to understand code before deciding.",
  S3: "S3 vs S2: within noise. Baseline test runs per task 2.0 → 1.7 (the rule itself allows two: one before, one after), turns 48 → 43, tokens −14%, cost −7%. cheapag was already near the floor (0.14 test runs and 1 turn after delegating per task in S2) and went up on one instance: on django-11066 Claude re-ran the tests 4 times after an OK job despite the trust-OK rule (turns 20 → 24, tokens +20%). All 14 resolved, django-13449 included, so the rule was not relaxed. A ~2-turn floor per task (delegate, then answer) leaves this lever little to cut in cheapag; in the baseline, turns are spent reading and editing, not testing.",
  S2: "S2 vs S1: cache writes per task barely moved (baseline 10.5k → 9.2k, cheapag 9.5k → 9.7k), because S1 had already made the prefix byte-identical across tasks: within a run, only each arm's first session writes the ~19k prefix, and every later one writes just its own task (~3k baseline, ~6k cheapag). The dollar drop ($/task 0.161 → 0.105 baseline, 0.105 → 0.075 cheapag) is mostly the 5-minute TTL's cheaper writes ($5/M instead of $8/M) and run-to-run noise. Tokens fell 8–18%; dollars fell 29–35%, so on a subscription the saving depends on how cache writes weigh against quota (unpublished). cheapag's per-task write is ~3k larger than the baseline's: the SessionStart context and the skill list ride in the first user message, after the cache breakpoint, so they are rewritten every session (a lever for later).",
};

const sum = (rs, k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
// Opus 5.5 list prices, fitted exactly from Claude Code's per-session modelUsage: $4/M input, $20/M output (cache reads
// $0.20/M, 5m writes $5/M). "No-cache $" prices every input token at $4/M: cache warmth can't move it, so rows compare.
const noCache = (rs) => rs.reduce((s, r) => s + ((r.input_tokens ?? 0) + (r.cache_creation_tokens ?? 0) + (r.cache_read_tokens ?? 0)) * 4e-6 + (r.output_tokens ?? 0) * 20e-6, 0);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
const ratio = (now, before) => (before ? `${(now / before).toFixed(2)}x` : "—");
const mins = (ms) => `${(ms / 60_000).toFixed(1)} min`;

const lines = [
  "| # | Label | Arm | Resolved | Claude tokens | Output | Cache writes | Cache reads | Est. $ | No-cache $ | Turns | Wall time | Worker $ | $ vs prev | No-cache $ vs prev | Tokens vs prev |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];
const prev = {};
const summary = [];
sweeps.forEach(([id, label], i) => {
  const rs = rows.filter((r) => r.sweep === id);
  // the whole quick run, sessions and grading, from its start to its last recorded row
  const wall = Math.max(...rs.map((r) => Date.parse(r.ended_at ?? id))) - Date.parse(id);
  const byArm = Map.groupBy(rs, (r) => r.arm);
  for (const [arm, g] of [...byArm.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cost = sum(g, "claude_cost_usd"), tokens = sum(g, "claude_tokens"), raw = noCache(g);
    const p = prev[arm];
    lines.push(`| ${i} | ${label} | ${arm} | ${g.filter((r) => r.resolved).length}/${g.length} | ${k(tokens)} | ${k(sum(g, "output_tokens"))} | ${k(sum(g, "cache_creation_tokens"))} | ${k(sum(g, "cache_read_tokens"))} | $${cost.toFixed(2)} | $${raw.toFixed(2)} | ${sum(g, "num_turns")} | ${mins(wall)} | $${sum(g, "worker_cost_usd").toFixed(3)} | ${ratio(cost, p?.cost)} | ${ratio(raw, p?.raw)} | ${ratio(tokens, p?.tokens)} |`);
    prev[arm] = { cost, tokens, raw };
  }
  const b = byArm.get("baseline"), c = byArm.get("cheapag");
  const note = Object.entries(NOTES).find(([prefix]) => label.startsWith(prefix + " "))?.[1];
  if (b && c) summary.push(`- **${i} · ${label}:** cheapag costs ${ratio(sum(c, "claude_cost_usd"), sum(b, "claude_cost_usd"))} of baseline (${ratio(noCache(c), noCache(b))} without cache), uses ${ratio(sum(c, "claude_tokens"), sum(b, "claude_tokens"))} of its tokens; resolved ${c.filter((r) => r.resolved).length}/${c.length} vs ${b.filter((r) => r.resolved).length}/${b.length}.${note ? `\n  ${note}` : ""}`);
});

const md = `# Cost ladder

One row per quick run (\`node bench/swe/run.mjs --quick --label "<lever>"\`, 7 instances in \`bench/swe/quick.json\`) and arm, oldest first. Regenerate with \`node bench/swe/ladder.mjs\`.

**How to read it** (ticket 23.0): on 7 instances a move under **25%** in tokens or dollars is noise. Resolves are a guard: below 6/7 in either arm, run the quick set again before judging. The quick set shows *direction*; the full bench (23.9) shows *size*. "vs prev" compares with the previous row of the same arm.

**Cache warmth confounds rows** (seen on the two S0 reference runs, identical code 4 minutes apart: cost halved, cache writes 141k → 48k and 144k → 19k). A run that starts while the previous run's prompt cache is still warm is cheaper for that reason alone. Compare rows started under the same condition: start each quick run cold (more than an hour after the previous one), or run a fresh reference right before the lever.

**Dollars are API-price estimates.** On a Pro/Max subscription the cost that matters is quota. Anthropic says cached tokens "count less" against plan limits but publishes no ratio, so a lever that moves tokens from cache writes to cache reads (S2) saves the estimated dollars shown here, and an unknown, probably smaller, share of quota.

${lines.join("\n")}

${summary.join("\n")}
`;
writeFileSync(join(root, "tasks", "cost-ladder.md"), md);
console.log(md);
