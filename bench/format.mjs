#!/usr/bin/env node
// Result-format measurement: the same job records rendered as the result block, pretty JSON and minified JSON.
// Tokens are approximated as chars/4 (no API key needed); the ratio is what matters. Reads every bench run's job records.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const runs = join(dirname(new URL(import.meta.url).pathname), ".runs");
const records = [];
for (const run of existsSync(runs) ? readdirSync(runs) : []) {
  const jobs = join(runs, run, ".cheapag", "jobs");
  if (!existsSync(jobs)) continue;
  for (const id of readdirSync(jobs)) {
    const dir = join(jobs, id);
    if (existsSync(join(dir, "result.json")) && existsSync(join(dir, "result.txt"))) records.push({ json: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), block: readFileSync(join(dir, "result.txt"), "utf8") });
  }
}
if (!records.length) { console.error("no job records under bench/.runs yet"); process.exit(1); }
// what Claude would read per format: the block as sent; the record as JSON, minus on-disk-only fields
const strip = ({ format, dir, worktree, sessionID, baseline, pid, ...rest }) => rest;
const tok = (s) => Math.ceil(s.length / 4);
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor((s.length - 1) / 2)], p90: s[Math.floor((s.length - 1) * 0.9)] }; };
const block = stat(records.map((r) => tok(r.block)));
const pretty = stat(records.map((r) => tok(JSON.stringify(strip(r.json), null, 2))));
const mini = stat(records.map((r) => tok(JSON.stringify(strip(r.json)))));
console.log(`Result format, ${records.length} job records (tokens ≈ chars/4):\n`);
console.log("| Format | Median tokens | p90 tokens | vs block (median) |\n|---|---|---|---|");
for (const [name, s] of [["result block", block], ["pretty JSON", pretty], ["minified JSON", mini]]) console.log(`| ${name} | ${s.median} | ${s.p90} | ${(s.median / block.median).toFixed(2)}x |`);
