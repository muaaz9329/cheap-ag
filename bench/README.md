# Benchmark: Claude alone vs Claude + Cheap Agent

Answers one question with numbers: how many Claude tokens does delegating save, and does the code still pass?

## Method

- **Fixture:** `bench/repo`, a tiny zero-dependency Node project (inventory, pricing, receipt, CLI) tested with `node --test`.
- **Tasks:** `bench/tasks.json`, eight fixed prompts of different kinds: feature, refactor, bug fix, test writing, cross-file migration, docs, research, and one deliberately vague task.
- **Grading:** hidden tests in `bench/tasks/<id>/hidden/` are copied into the run's `test/` folder **after** the run and the whole suite is executed. The research task is graded on its answer (file references) and on leaving the tree unchanged; the docs task must touch only `README.md`.
- **Arms:** both start from an identical fresh copy of the fixture, the same prompt, the same model, a fresh `claude -p` session, permissions skipped.
  - `baseline`: `--strict-mcp-config` with an empty MCP config, so no Cheap Agent at all.
  - `cheapag-hook`: as `cheapag`, plus `cheapag hook on`, so the plugin's edit guard denies large direct edits and points Claude at `delegate`. Measures delegation when Claude is pushed, not just asked.
  - `cheapag`: the MCP config points at this repo's local build (`dist/index.js`), plus `--plugin-dir` with the plugin's skills (its `.mcp.json` removed, since the npm package isn't published yet). Consent is pre-recorded with `cheapag allow`; `cheapag.json` sets `test_cmd` to `node --test`. Nothing in the prompt tells Claude to delegate: the server instructions and the plan-writing skill have to do that.
- **Metrics per run** (one JSON line in `bench/results.jsonl`): pass/fail with detail; Claude input, cache creation, cache read and output tokens and Claude Code's cost estimate (from the `--output-format json` result); wall time; worker cost, turns, job statuses, self-fixes and escalations (from `.cheapag/jobs/*/result.json`); and from the session transcript: tool uses, delegate/research calls, edits Claude made itself, and edits after the last delegation (the "manual fix" signal).

## Running

```bash
npm run build
node bench/run.mjs --tasks t1 --runs 1 --model sonnet      # pilot: one task, both arms
node bench/run.mjs --runs 2 --model opus                    # full sweep (8 tasks × 2 arms × 2 runs)
node bench/report.mjs --write                               # docs/benchmark.md
node bench/format.mjs                                       # result block vs JSON token sizes
```

Flags: `--tasks t1,t3` (id prefixes), `--arms baseline,cheapag,cheapag-hook`, `--runs N`, `--model <alias>`, `--timeout <minutes>` (default 25), `--dry`.

Needs a saved worker login (`npx cheap-agent login`) for the cheapag arm. Run dirs live under `bench/.runs/` (gitignored); each keeps `.bench-stdout.json` (the raw `claude -p` result), `.bench-grade.txt` and, for the cheapag arm, the full `.cheapag/` job records.

## Success criteria (spec)

Claude tokens per task at least 3x lower, the same pass rate, and fewer than 1 in 5 cheapag runs where Claude had to edit code itself after delegating.

## Caveats

- Claude Code's cost numbers are estimates; on a subscription they measure usage, not money.
- Few runs per cell. The report uses medians; treat differences under ~1.5x as noise.
- Hidden tests grade behaviour, not code quality.
- The fixture is small, so cheapag's fixed overhead (plan file, result blocks) weighs more than it would on a real repo.
