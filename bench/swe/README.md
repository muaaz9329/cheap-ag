# Benchmark v2: SWE-bench Verified, Claude alone vs Claude + Cheap Agent

24 instances of SWE-bench Verified (`instances.json`, picked by `select.mjs`: 8 × `<15 min fix`, 10 × `15 min - 1 hour`, 6 × `1-4 hours`), two arms, graded by the official harness. The question: does keeping exploration and test loops in the cheap worker cut Claude's usage on real-sized work?

## Setup (once)

- Docker engine with Rosetta for amd64 images: `brew install colima docker-buildx && colima start --cpu 8 --memory 16 --disk 150 --vm-type vz --vz-rosetta`.
- Harness in `bench/swe/.deps/` (gitignored): `python3.12 -m venv venv`, `pip install -e ./SWE-bench datasets` (clone `SWE-bench/SWE-bench`), clone `SWE-bench/swe-bench-tasks`, dump the dataset to `verified.jsonl`.
- Images: the published x86_64 images, pulled with `docker pull --platform linux/amd64 <image>` (the harness alone asks for arm64 and finds none). About 2–3 GB each after shared layers.
- Gold check: `swebench eval verified --gold -i <ids…> --run-id gold-check -j 3` from `bench/swe/`, all must resolve.
- A worker login (`npx cheap-agent login`) for the cheapag arm; `npm run build`.

## Running

```bash
node bench/swe/run.mjs --run 1                          # every instance, both arms
node bench/swe/run.mjs --instances <id,…> --run 2       # a second run for chosen instances
node bench/swe/run.mjs --long --run 1                   # the long-session scenario (4 django tasks, one session per arm)
node bench/swe/run.mjs --dry                            # checkouts and commands only
node bench/swe/run.mjs --quick --label "S1 stable prefix"  # the 7-instance quick set (quick.json), ~15 min
node bench/swe/ladder.mjs                               # the cost ladder → tasks/cost-ladder.md
```

A quick run grades all its patches at the end in one parallel harness call per arm (one at a time added ~10 min) and records its rows with `suite: "swebench-quick"`. Back-to-back quick runs are not comparable: the second starts with a warm prompt cache and costs about half (see tasks/cost-ladder.md).

Flags: `--arms baseline,cheapag`, `--timeout <min>` (default 60), `--label`, `--budget` / `--worker-budget` (stops at 80% of either, default $100 / $5).

## How a session runs

- **Checkout:** the repo comes out of the instance image (`/testbed/.git`, full history), then a git worktree at `base_commit` in `.runs/`.
- **Prompt:** the issue's `problem_statement` only (never hints, test patch or test names), plus one line on `./swebench-test.sh`.
- **Tests:** `./swebench-test.sh <test args>` streams the checkout's changed and new files over `/testbed` in the instance image and runs the test command from the task's `eval.sh`. It works from any worktree, Cheap Agent's included.
- **cheapag arm:** the local build via `--mcp-config`, plus the plugin's skills via `--plugin-dir`. `cheapag.json` allows exactly `./swebench-test.sh`; there is no `test_cmd`, because the whole suite takes an hour or more under Rosetta. Plain `docker` stays denied to the worker.
- **Grading:** the patch against `base_commit` (helper files and `.cheapag/` excluded) is graded per instance with `swebench eval verified`, and `resolved` is merged into the row.
- **Results:** one row per session in `bench/results.jsonl` (`suite: "swebench-verified"`), shown by `bench/dashboard.mjs` with difficulty grouping, `resolved` and `max_context`.

## Caveats

- Claude Code's `total_cost_usd` is an estimate (usage on a subscription). Cache writes cost far more per token than cache reads, so compare **cost** as well as raw tokens.
- A session that backgrounds a slow test and waits (Monitor, ScheduleWakeup) ends early under `claude -p` and under-reports usage. Check `tools_used` for those.
