#!/usr/bin/env node
// Builds bench/dashboard.html from bench/results.jsonl: one section per benchmark run (newest first) plus a
// trend chart across runs. bench/run.mjs calls this after every recorded row, so the page is always current.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const src = join(here, "results.jsonl");
const rows = existsSync(src) ? readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.sweep) : [];

// only the fields the page shows; the page renders everything with textContent
const keep = ["sweep", "sweep_label", "task", "kind", "arm", "run", "model", "pass", "grade_detail", "input_tokens", "cache_creation_tokens", "cache_read_tokens", "output_tokens", "claude_tokens", "claude_cost_usd", "num_turns", "tool_uses", "duration_ms", "worker_cost_usd", "delegate_calls", "difficulty", "max_context", "worker_fails", "claude_edits_after_delegate", "long_session"];
const data = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] ?? null])));
// "<" escaped so a task name can never close the script tag
const json = JSON.stringify(data).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Benchmark</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --good: #006300; --bad: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --good: #0ca30c; --bad: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  --good: #0ca30c; --bad: #e66767;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 17px; margin: 0 0 4px; }
h3 { font-size: 14px; margin: 20px 0 8px; color: var(--ink-2); font-weight: 600; }
.sub { color: var(--ink-2); margin: 4px 0 0; }
.card { background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px var(--ring); padding: 20px; margin-top: 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 16px; }
.tile { padding: 12px 14px; border-radius: 10px; box-shadow: 0 0 0 1px var(--ring); }
.tile .k { color: var(--ink-2); font-size: 12px; }
.tile .v { font-size: 22px; font-weight: 650; margin-top: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0 4px; color: var(--ink-2); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg .label { fill: var(--ink-2); font-size: 12px; }
svg .total { fill: var(--ink); font-size: 12px; font-weight: 600; }
svg .seg { cursor: default; outline: none; }
svg .seg:hover, svg .seg:focus { filter: brightness(1.12); }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--ink-2); font-weight: 600; }
.pass { color: var(--good); font-weight: 600; }
.fail { color: var(--bad); font-weight: 600; }
.empty { color: var(--ink-2); }
#tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); box-shadow: 0 0 0 1px var(--ring), 0 4px 16px rgba(0,0,0,.12); border-radius: 8px; padding: 8px 10px; font-size: 12px; display: none; z-index: 10; min-width: 160px; }
#tip .v { font-size: 14px; font-weight: 650; }
#tip .row { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
#tip .row b { width: 12px; height: 2px; display: inline-block; }
button.theme { background: none; border: 0; color: var(--ink-2); cursor: pointer; font: inherit; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Claude Code Benchmark</h1>
      <p class="sub" id="meta"></p>
    </div>
    <button class="theme" id="theme" type="button">Toggle theme</button>
  </header>
  <section class="card" id="trend"></section>
  <div id="runs"></div>
</main>
<div id="tip" role="status" aria-live="polite"></div>
<script>
const DATA = ${json};
const TYPES = [
  { key: "cache_read_tokens", name: "Cache read", color: "var(--s1)" },
  { key: "cache_creation_tokens", name: "Cache write", color: "var(--s2)" },
  { key: "output_tokens", name: "Output", color: "var(--s3)" },
  { key: "input_tokens", name: "Input (uncached)", color: "var(--s4)" },
];
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, text) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
const sv = (tag, attrs = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k" : String(Math.round(n));
const full = (n) => Math.round(n).toLocaleString("en-US");
const usd = (n) => n == null ? "—" : "$" + n.toFixed(n < 1 ? 3 : 2);
const secs = (ms) => ms == null ? "—" : Math.round(ms / 1000) + "s";
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const median = (rows, k) => { const v = rows.map((r) => r[k] || 0).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)) : 0; };
const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };

// tooltip: values lead, labels follow; shared by every chart
const tip = document.getElementById("tip");
function showTip(evt, title, lines) {
  tip.replaceChildren();
  tip.append(el("div", { class: "v" }, lines[0].value), el("div", {}, title));
  for (const l of lines.slice(1)) { const r = el("div", { class: "row" }); const key = el("b"); key.style.background = l.color || "transparent"; r.append(key, document.createTextNode(l.label + ": " + l.value)); tip.append(r); }
  tip.style.display = "block";
  const box = evt.target.getBoundingClientRect?.() || { left: 0, top: 0 };
  const x = evt.clientX ?? box.left + 8, y = evt.clientY ?? box.top;
  tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + "px";
}
const hideTip = () => (tip.style.display = "none");

function legend() {
  const l = el("div", { class: "legend" });
  for (const t of TYPES) { const s = el("span"); const i = el("i"); i.style.background = t.color; s.append(i, document.createTextNode(t.name)); l.append(s); }
  return l;
}

/** Stacked bars of token types. dir "h": one row per item (label left, total right); dir "v": one column per item. */
function stacked(items, dir, onTip) {
  const max = niceMax(Math.max(...items.map((it) => it.total)));
  if (dir === "h") {
    const labelW = 150, totalW = 64, rowH = 30, barH = 16, W = 960, plotW = W - labelW - totalW, H = items.length * rowH + 24;
    const svg = sv("svg", { viewBox: \`0 0 \${W} \${H}\`, role: "img" });
    for (let i = 0; i <= 4; i++) {
      const x = labelW + (plotW * i) / 4;
      svg.append(sv("line", { x1: x, x2: x, y1: 0, y2: H - 20, stroke: i ? "var(--grid)" : "var(--axis)", "stroke-width": 1 }));
      svg.append(sv("text", { x, y: H - 4, "text-anchor": i ? (i === 4 ? "end" : "middle") : "start" }, fmt((max * i) / 4)));
    }
    items.forEach((it, idx) => {
      const y = idx * rowH + (rowH - barH) / 2;
      svg.append(sv("text", { class: "label", x: labelW - 10, y: y + barH / 2 + 4, "text-anchor": "end" }, it.label));
      const w = (it.total / max) * plotW;
      const clipId = "c" + Math.random().toString(36).slice(2);
      const clip = sv("clipPath", { id: clipId });
      clip.append(sv("rect", { x: labelW - 4, y, width: w + 4, height: barH, rx: 4 }));
      svg.append(clip);
      const g = sv("g", { "clip-path": \`url(#\${clipId})\` });
      let x = labelW;
      for (const t of TYPES) {
        const v = it.values[t.key] || 0; if (!v) continue;
        const sw = (v / max) * plotW;
        const r = sv("rect", { class: "seg", x, y, width: Math.max(0, sw - (x + sw < labelW + w - 0.5 ? 2 : 0)), height: barH, fill: t.color, tabindex: 0 });
        const tipFor = (e) => onTip(e, it, t);
        r.addEventListener("pointermove", tipFor); r.addEventListener("focus", tipFor); r.addEventListener("pointerleave", hideTip); r.addEventListener("blur", hideTip);
        g.append(r); x += sw;
      }
      svg.append(g);
      svg.append(sv("text", { class: "total", x: labelW + w + 8, y: y + barH / 2 + 4 }, fmt(it.total)));
    });
    return svg;
  }
  const W = 960, H = 260, left = 52, bottom = 40, top = 22, plotW = W - left - 8, plotH = H - top - bottom;
  const svg = sv("svg", { viewBox: \`0 0 \${W} \${H}\`, role: "img" });
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH - (plotH * i) / 4;
    svg.append(sv("line", { x1: left, x2: W - 8, y1: y, y2: y, stroke: i ? "var(--grid)" : "var(--axis)", "stroke-width": 1 }));
    svg.append(sv("text", { x: left - 8, y: y + 4, "text-anchor": "end" }, fmt((max * i) / 4)));
  }
  const slot = plotW / Math.max(items.length, 1), bw = Math.min(56, slot * 0.6);
  items.forEach((it, idx) => {
    const cx = left + slot * idx + slot / 2, x0 = cx - bw / 2, h = (it.total / max) * plotH, yTop = top + plotH - h;
    const clipId = "c" + Math.random().toString(36).slice(2);
    const clip = sv("clipPath", { id: clipId });
    clip.append(sv("rect", { x: x0, y: yTop, width: bw, height: h + 4, rx: 4 }));
    svg.append(clip);
    const g = sv("g", { "clip-path": \`url(#\${clipId})\` });
    let y = top + plotH;
    for (const t of TYPES) {
      const v = it.values[t.key] || 0; if (!v) continue;
      const sh = (v / max) * plotH; y -= sh;
      const r = sv("rect", { class: "seg", x: x0, y: y + (y > yTop + 0.5 ? 2 : 0), width: bw, height: Math.max(0, sh - (y > yTop + 0.5 ? 2 : 0)), fill: t.color, tabindex: 0 });
      const tipFor = (e) => onTip(e, it, t);
      r.addEventListener("pointermove", tipFor); r.addEventListener("focus", tipFor); r.addEventListener("pointerleave", hideTip); r.addEventListener("blur", hideTip);
      g.append(r);
    }
    svg.append(g);
    svg.append(sv("text", { class: "total", x: cx, y: yTop - 6, "text-anchor": "middle" }, fmt(it.total)));
    svg.append(sv("text", { class: "label", x: cx, y: H - bottom + 16, "text-anchor": "middle" }, it.label));
    svg.append(sv("text", { x: cx, y: H - bottom + 31, "text-anchor": "middle" }, it.sublabel || ""));
  });
  return svg;
}

function tokenTip(e, it, t) {
  showTip(e, it.title || it.label, [
    { value: full(it.values[t.key] || 0) + " " + t.name.toLowerCase() },
    ...TYPES.map((x) => ({ label: x.name, value: full(it.values[x.key] || 0), color: x.color })),
    { label: "Total", value: full(it.total) },
  ]);
}

function table(headers, rows) {
  const wrap = el("div", { class: "scroll" }), t = el("table"), thead = el("thead"), tr = el("tr");
  for (const h of headers) tr.append(el("th", {}, h));
  thead.append(tr); t.append(thead);
  const tb = el("tbody");
  for (const r of rows) { const row = el("tr"); for (const c of r) { const td = el("td"); if (c && typeof c === "object") { td.textContent = c.text; td.className = c.cls; } else td.textContent = c; row.append(td); } tb.append(row); }
  t.append(tb); wrap.append(t); return wrap;
}

function tile(k, v) { const d = el("div", { class: "tile" }); d.append(el("div", { class: "k" }, k), el("div", { class: "v" }, v)); return d; }

const sweeps = [...new Map(DATA.map((r) => [r.sweep, r.sweep_label])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
const when = (id) => new Date(id).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
document.getElementById("meta").textContent = sweeps.length ? \`\${sweeps.length} benchmark run\${sweeps.length > 1 ? "s" : ""} · \${DATA.length} task runs · latest \${when(sweeps.at(-1)[0])}\` : "No benchmark runs recorded yet.";

// trend: one bar per benchmark run
const trend = document.getElementById("trend");
trend.append(el("h2", {}, "Claude tokens per benchmark run"));
trend.append(el("p", { class: "sub" }, "Total across all tasks in the run, split by token type. Hover a segment for exact values."));
if (sweeps.length) {
  trend.append(legend());
  const items = sweeps.map(([id, label], i) => {
    const rs = DATA.filter((r) => r.sweep === id);
    return { label: "Run " + (i + 1), sublabel: label, title: "Run " + (i + 1) + " · " + label + " · " + when(id), total: sum(rs, "claude_tokens"), values: Object.fromEntries(TYPES.map((t) => [t.key, sum(rs, t.key)])) };
  });
  trend.append(stacked(items, "v", tokenTip));
  const d = el("details"); d.append(el("summary", {}, "Table"));
  d.append(table(["Run", "Label", "When", "Tasks", "Pass", "Total tokens", "Cache read", "Cache write", "Output", "Input", "Cost (est.)", "Turns", "Time"],
    sweeps.map(([id, label], i) => { const rs = DATA.filter((r) => r.sweep === id); return ["Run " + (i + 1), label, when(id), rs.length, rs.filter((r) => r.pass).length + "/" + rs.length, full(sum(rs, "claude_tokens")), full(sum(rs, "cache_read_tokens")), full(sum(rs, "cache_creation_tokens")), full(sum(rs, "output_tokens")), full(sum(rs, "input_tokens")), usd(sum(rs, "claude_cost_usd")), sum(rs, "num_turns"), secs(sum(rs, "duration_ms"))]; })));
  trend.append(d);
} else trend.append(el("p", { class: "empty" }, "Run bench/run.mjs to record the first benchmark."));

// one section per run, newest first; older runs collapsed
const runs = document.getElementById("runs");
sweeps.slice().reverse().forEach(([id, label], ri) => {
  const n = sweeps.length - ri, rs = DATA.filter((r) => r.sweep === id);
  const card = el("section", { class: "card" });
  const body = ri === 0 ? card : el("details");
  if (ri) { body.append(el("summary", {}, \`Run \${n} · \${label} · \${when(id)} · \${fmt(sum(rs, "claude_tokens"))} tokens\`)); card.append(body); }
  else { card.append(el("h2", {}, \`Run \${n} (latest) · \${label}\`)); card.append(el("p", { class: "sub" }, when(id))); }
  const tiles = el("div", { class: "tiles" });
  tiles.append(tile("Total tokens", fmt(sum(rs, "claude_tokens"))), tile("Output tokens", fmt(sum(rs, "output_tokens"))), tile("Cost (est.)", usd(sum(rs, "claude_cost_usd"))),
    tile("Pass", rs.filter((r) => r.pass).length + " / " + rs.length), tile("Turns", String(sum(rs, "num_turns"))), tile("Wall time", secs(sum(rs, "duration_ms"))));
  body.append(tiles);
  body.append(el("h3", {}, "Tokens per task"));
  body.append(legend());
  const multiArm = new Set(rs.map((r) => r.arm)).size > 1, multiRun = new Set(rs.map((r) => r.run)).size > 1;
  // SWE-bench rows (bench/swe): grouped by difficulty, with max context; their "pass" is the harness's resolved
  const swe = rs.some((r) => r.difficulty);
  if (swe) {
    const ORDER = ["<15 min fix", "15 min - 1 hour", "1-4 hours"];
    rs.sort((a, b) => ORDER.indexOf(a.difficulty) - ORDER.indexOf(b.difficulty) || (a.long_session ?? 0) - (b.long_session ?? 0));
    body.append(el("h3", {}, "By difficulty"));
    const groups = [...new Set(rs.map((r) => r.difficulty + "\u0000" + r.arm))].map((k) => k.split("\u0000"));
    body.append(table(["Difficulty", "Arm", "Runs", "Resolved", "Tokens (median)", "Output (median)", "Cost", "Turns (median)", "Max context (median)", "Delegations", "Worker fails", "Claude edits after delegating"],
      groups.map(([d, a]) => { const g = rs.filter((r) => r.difficulty === d && r.arm === a); return [d, a, g.length, g.filter((r) => r.pass).length + "/" + g.length, full(median(g, "claude_tokens")), full(median(g, "output_tokens")), usd(sum(g, "claude_cost_usd")), median(g, "num_turns"), full(median(g, "max_context")), sum(g, "delegate_calls"), sum(g, "worker_fails"), sum(g, "claude_edits_after_delegate")]; })));
  }
  const items = rs.map((r) => ({ label: r.task + (multiArm ? " · " + r.arm : "") + (multiRun ? " #" + r.run : ""), total: r.claude_tokens || 0, values: Object.fromEntries(TYPES.map((t) => [t.key, r[t.key] || 0])) }));
  body.append(stacked(items, "h", tokenTip));
  body.append(el("h3", {}, "All numbers"));
  body.append(table(["Task", ...(swe ? ["Difficulty"] : []), ...(multiArm ? ["Arm"] : []), ...(multiRun ? ["Run"] : []), "Result", ...(swe ? ["Max context"] : []), "Total", "Cache read", "Cache write", "Output", "Input", "Cost (est.)", "Turns", "Tools", "Time"],
    rs.map((r) => [r.task + (r.long_session ? " (long #" + r.long_session + ")" : ""), ...(swe ? [r.difficulty] : []), ...(multiArm ? [r.arm] : []), ...(multiRun ? [r.run] : []), { text: r.pass ? (swe ? "✓ resolved" : "✓ pass") : swe ? "✗ unresolved" : "✗ fail", cls: r.pass ? "pass" : "fail" }, ...(swe ? [full(r.max_context || 0)] : []), full(r.claude_tokens || 0), full(r.cache_read_tokens || 0), full(r.cache_creation_tokens || 0), full(r.output_tokens || 0), full(r.input_tokens || 0), usd(r.claude_cost_usd), r.num_turns ?? "—", r.tool_uses ?? "—", secs(r.duration_ms)])));
  const fails = rs.filter((r) => !r.pass && r.grade_detail);
  if (fails.length) { const d = el("details"); d.append(el("summary", {}, "Why tasks failed")); for (const f of fails) d.append(el("p", { class: "sub" }, f.task + ": " + f.grade_detail)); body.append(d); }
  runs.append(card);
});

// theme toggle: the page follows the OS until the reader picks one
const root = document.documentElement;
try { const saved = localStorage.getItem("bench-theme"); if (saved) root.dataset.theme = saved; } catch {}
document.getElementById("theme").addEventListener("click", () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("bench-theme", root.dataset.theme); } catch {}
});
</script>
</body>
</html>
`;

writeFileSync(join(here, "dashboard.html"), html);
console.log(`wrote bench/dashboard.html (${new Set(rows.map((r) => r.sweep)).size} runs, ${rows.length} task rows)`);
