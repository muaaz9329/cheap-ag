#!/usr/bin/env node
// Turns bench/results.jsonl into a markdown report (stdout, and docs/benchmark.md with --write).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const file = join(here, "results.jsonl");
if (!existsSync(file)) { console.error("no results yet: run bench/run.mjs first"); process.exit(1); }
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.dry);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const by = (key) => rows.reduce((m, r) => ((m[key(r)] ??= []).push(r), m), {});

const tasks = [...new Set(rows.map((r) => r.task))];
const armsSeen = ["baseline", "cheapag", "cheapag-hook"].filter((a) => rows.some((r) => r.arm === a));
const lines = [];
lines.push("# Cheap Agent benchmark", "", `Model: ${[...new Set(rows.map((r) => r.model))].join(", ")}. Runs per cell: ${med(Object.values(by((r) => r.task + r.arm)).map((g) => g.length))} (median). Generated ${new Date().toISOString().slice(0, 10)} from ${rows.length} runs.`, "");
lines.push("Claude tokens = input + cache creation + cache read + output, as Claude Code reports them for the whole session. Worker cost is the cheap model's spend from the job records. Pass = the task's hidden tests (or answer check) passed.", "");
lines.push("| Task | Arm | Pass | Claude tokens (med) | Output tokens (med) | Claude cost (med) | Worker cost (med) | Time (med) | Delegations | Claude edits after delegating |", "|---|---|---|---|---|---|---|---|---|---|");
const totals = {};
for (const task of tasks) {
  for (const arm of armsSeen) {
    const g = rows.filter((r) => r.task === task && r.arm === arm);
    if (!g.length) continue;
    const t = (totals[arm] ??= { tokens: [], out: [], cost: [], worker: [], pass: 0, n: 0, fixes: 0, delegated: 0 });
    t.tokens.push(med(g.map((r) => r.claude_tokens))); t.out.push(med(g.map((r) => r.output_tokens)));
    t.cost.push(med(g.map((r) => r.claude_cost_usd ?? 0))); t.worker.push(med(g.map((r) => r.worker_cost_usd)));
    t.pass += g.filter((r) => r.pass).length; t.n += g.length; t.fixes += g.filter((r) => r.claude_edits_after_delegate > 0).length; t.delegated += g.filter((r) => r.delegate_calls > 0).length;
    lines.push(`| ${task} | ${arm} | ${g.filter((r) => r.pass).length}/${g.length} | ${fmt(med(g.map((r) => r.claude_tokens)))} | ${fmt(med(g.map((r) => r.output_tokens)))} | $${fmt(med(g.map((r) => r.claude_cost_usd ?? 0)), 3)} | $${fmt(med(g.map((r) => r.worker_cost_usd)), 4)} | ${fmt(med(g.map((r) => r.duration_ms)) / 1000)}s | ${fmt(med(g.map((r) => r.delegate_calls)))} | ${fmt(med(g.map((r) => r.claude_edits_after_delegate)))} |`);
  }
}
lines.push("", "## Totals (sum of per-task medians)", "", "| Arm | Pass rate | Claude tokens | Output tokens | Claude cost | Worker cost | Runs that delegated | Runs where Claude edited after delegating |", "|---|---|---|---|---|---|---|---|");
for (const [arm, t] of Object.entries(totals)) {
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  lines.push(`| ${arm} | ${t.pass}/${t.n} | ${fmt(sum(t.tokens))} | ${fmt(sum(t.out))} | $${fmt(sum(t.cost), 2)} | $${fmt(sum(t.worker), 3)} | ${t.delegated}/${t.n} | ${t.fixes}/${t.n} |`);
}
for (const arm of armsSeen.filter((a) => a !== "baseline" && totals.baseline)) {
  const t = totals[arm];
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const ratio = sum(totals.baseline.tokens) / Math.max(1, sum(t.tokens));
  const outRatio = sum(totals.baseline.out) / Math.max(1, sum(t.out));
  const passB = totals.baseline.pass / totals.baseline.n, passC = t.pass / t.n;
  lines.push("", `## Success criteria (spec): ${arm} vs baseline`, "", `- Claude tokens ≥ 3x lower: **${ratio.toFixed(2)}x** (${ratio >= 3 ? "met" : "not met"}); output tokens ${outRatio.toFixed(2)}x`,
    `- Pass rate unchanged: baseline ${(passB * 100).toFixed(0)}%, ${arm} ${(passC * 100).toFixed(0)}% (${passC >= passB ? "met" : "not met"})`,
    `- Fewer than 1 in 5 runs need Claude to fix the worker's output by hand: ${t.fixes}/${t.n} (${t.fixes / t.n < 0.2 ? "met" : "not met"})`,
    `- Runs where Claude delegated${arm === "cheapag" ? " on its own" : " (hook on)"}: ${t.delegated}/${t.n}`);
}
lines.push("", "## Per-kind view", "", "| Kind | Arm | Tokens (med) | vs baseline | Pass |", "|---|---|---|---|---|");
for (const [kind, g] of Object.entries(by((r) => r.kind))) {
  const b = g.filter((r) => r.arm === "baseline");
  for (const arm of armsSeen) {
    const c = g.filter((r) => r.arm === arm);
    if (!c.length) continue;
    const ratio = b.length && arm !== "baseline" ? `${(med(b.map((r) => r.claude_tokens)) / Math.max(1, med(c.map((r) => r.claude_tokens)))).toFixed(2)}x` : "—";
    lines.push(`| ${kind} | ${arm} | ${fmt(med(c.map((r) => r.claude_tokens)))} | ${ratio} | ${c.filter((r) => r.pass).length}/${c.length} |`);
  }
}
lines.push("", "## Caveats", "", "- Same model, prompt and starting commit for both arms; each run is a fresh `claude -p` session with permissions skipped.", "- The cheapag arm gets the plugin's skills (plan-writing) and the server's instructions; nothing in the prompt tells Claude to delegate. The cheapag-hook arm adds the edit guard, which denies large direct edits and points Claude at delegate.", "- Token counts come from Claude Code's own session usage; costs are Claude Code's estimates (subscription users pay no per-token bill, so read them as usage).", "- Hidden tests grade behaviour, not code quality. A run can pass with ugly code.", "- Few runs per cell; medians, not means. Treat differences under ~1.5x as noise.");
const md = lines.join("\n") + "\n";
console.log(md);
if (process.argv.includes("--write")) { writeFileSync(join(dirname(here), "docs", "benchmark.md"), md); console.error("wrote docs/benchmark.md"); }
