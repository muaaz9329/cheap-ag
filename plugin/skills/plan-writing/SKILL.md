---
name: plan-writing
description: Write or fix a Cheap Agent plan file before calling the cheapag delegate tool. Use when planning a change of more than ~20 lines or several files for the cheap worker, splitting work into steps, or after delegate rejects a plan.
---

# Writing a Cheap Agent plan

The cheap worker sees the whole plan, then implements the steps you name in `delegate`. It works in an isolated copy of the repo and does only what a step says, so each step must stand on its own: exact files, what to build, and a check that proves it works.

Save plans under `.plan/` in the repository, e.g. `.plan/rate-limit.md` (the developer may read, edit or commit them). Pass the path relative to the repository root.

## Grammar

```
# <plan title>                              ← required, exactly one H1
<shared context, optional, ≤ ~15 lines>
## <id> <short title>                       ← id = integer or integer+letter (3, 3a; s3, step-3 also work)
files: <path>, <dir/>, ...                  ← required; scope + overlap key
do: <what to build; continuation lines indented 2+ spaces>
done-when: <condition>; <condition>         ← required; `backticked` = executed
dont: <constraint>; <constraint>
needs: <step id>, ...
difficulty: easy | medium | hard            ← picks the worker model; wins over delegate's
model: <model>
deps: <package@range>                       ← the step needs a new package
```

- Keys are lowercase, at the start of the line, never bullets (`- files:` is wrong). Continuation lines are indented 2+ spaces.
- In `done-when`, every `backticked` fragment is run as a shell command in the worker's copy and must exit 0. Put only commands in backticks; plain text is the worker's responsibility.
- Unknown keys (e.g. `api:`, `example:`) are passed to the worker as hints.

## Rules

- **Size:** one step ≈ under an hour of junior-developer work. Split anything bigger.
- **Checks:** give every step an executable `done-when` (a test command, a type check), not only prose. Name the one test file or test id the step concerns, never the whole suite.
- **Source:** put the user's request or the issue verbatim in the shared context, or pass it as `delegate(source=…)` (text or a file path): the worker checks your steps against it and reports where they disagree.
- **Scope:** `files:` lists every file or directory the step may touch, accurately. It also decides which steps can run in parallel.
- **Constraints:** add `dont:` for the mistakes you expect (new dependencies, touching auth, changing public APIs).
- **Grouping:** make independent steps separate comma groups so they run in parallel; use `needs:` when one step must land first.
- **Packages:** declare a new package with `deps:`; the worker cannot install packages itself.
- Share context once at the top (conventions, existing helpers to reuse) instead of repeating it per step.

## Example

```md
# Rate limiting for auth endpoints
Redis is already wired in src/lib/redis.ts. Keep middleware style consistent with src/middleware/*.

## 1 limiter lib
files: src/lib/rateLimit.ts, test/rateLimit.test.ts
do: sliding-window limiter `limit(key, max, windowSec) -> {allowed, retryAfter}` using redis ZSET.
done-when: `npm test -- rateLimit` passes; tests cover allow, block, window expiry
dont: add dependencies

## 2 wire into login
files: src/api/login.ts, src/middleware/, test/login.test.ts
do: 5 req/min per IP on POST /api/login; on block return 429 + Retry-After.
done-when: `npm test -- login` passes; new test: 6th request → 429
dont: touch auth/session logic
needs: 1

## 3 docs
files: docs/api.md
do: document the 429 response and Retry-After.
done-when: section "Rate limits" exists under /api/login
```

## Delegating it

- `steps="3"`: one step, one job. `steps="3-5"`: a range, run in order in one job. `steps="1-2,3"`: comma-separated groups, run in parallel unless their `files:` overlap or `needs:` orders them.
- `delegate(plan=".plan/rate-limit.md", steps="1-2,3")`
- `delegate(plan=".plan/rate-limit.md", steps="2", note="use the existing ipFrom(req) helper")`: a `note` is at most 300 characters, for one-off guidance.
