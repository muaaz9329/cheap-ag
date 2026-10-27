#!/usr/bin/env node
// Ticket 26's calibration: can Claude rate a task's difficulty from the issue text alone? One `claude -p` per instance in
// instances.json (Opus, lean flags, no tools, one turn), compared with SWE-bench's difficulty labels. ~$1, no Docker.
// Usage: node bench/swe/calibrate.mjs [--dataset <verified.jsonl>] (default: bench/swe/.deps/verified.jsonl)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claude, fail, parseArgs } from "../lib.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const opts = parseArgs(process.argv.slice(2));
const TIERS = ["easy", "medium", "hard"];
const LABELS = { "<15 min fix": "easy", "15 min - 1 hour": "medium", "1-4 hours": "hard" };
// the delegate description's definitions (src/server.ts DIFFICULTY_HINT), as one question
const ASK = "Rate how hard this issue is to fix in its repository, as the time an experienced engineer new to the code needs to fix and test it: easy = under 15 minutes, medium = 15 minutes to an hour, hard = over an hour. Answer with one word: easy, medium or hard.";

const dataset = new Map(readFileSync(opts.dataset ?? join(here, ".deps", "verified.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.instance_id, r]));
const all = JSON.parse(readFileSync(join(here, "instances.json"), "utf8"));
const cwd = mkdtempSync(join(tmpdir(), "cheapag-calibrate-"));
const mcp = `${cwd}.mcp.json`; // beside the session's dir, which stays empty
writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));

const rows = [];
for (const inst of all) {
  const issue = dataset.get(inst.instance_id)?.problem_statement.trim() ?? fail(`${inst.instance_id} is not in the dataset`);
  const args = [
    "-p", `${ASK}\n\n<issue>\n${issue}\n</issue>`, "--output-format", "json", "--model", "opus", "--max-turns", "1", "--tools", "",
    "--strict-mcp-config", "--mcp-config", mcp, "--setting-sources", "project", "--exclude-dynamic-system-prompt-sections",
    "--settings", JSON.stringify({ includeGitInstructions: false }), "--disable-slash-commands",
  ];
  const { stdout } = await claude(args, cwd, 180_000);
  let out = {};
  try { out = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { out = { result: stdout.slice(-200) }; }
  const u = out.usage ?? {};
  const rated = String(out.result ?? "").toLowerCase().match(/\b(easy|medium|hard)\b/)?.[1] ?? "?";
  const label = LABELS[inst.difficulty];
  rows.push({ id: inst.instance_id, swe: inst.difficulty, label, rated, cost: out.total_cost_usd ?? 0,
    tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) });
  const r = rows.at(-1);
  console.error(`${r.id}: ${r.label} → ${r.rated}`);
}
rmSync(cwd, { recursive: true, force: true });
rmSync(mcp, { force: true });

const gap = (r) => (r.rated === "?" ? Infinity : Math.abs(TIERS.indexOf(r.rated) - TIERS.indexOf(r.label)));
const pct = (n) => `${n}/${rows.length} (${Math.round((100 * n) / rows.length)}%)`;
const hard = rows.filter((r) => r.label === "hard");
console.log(`| instance | SWE-bench | tier | Claude | |\n|---|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.id} | ${r.swe} | ${r.label} | ${r.rated} | ${gap(r) === 0 ? "=" : gap(r) === 1 ? "±1" : "✗"} |`);
console.log(`\nexact: ${pct(rows.filter((r) => gap(r) === 0).length)}; within one tier: ${pct(rows.filter((r) => gap(r) <= 1).length)}; hard rated easy: ${hard.filter((r) => r.rated === "easy").length} of ${hard.length}`);
console.log(`Claude: ${rows.reduce((s, r) => s + r.tokens, 0)} tokens, $${rows.reduce((s, r) => s + r.cost, 0).toFixed(2)}`);
