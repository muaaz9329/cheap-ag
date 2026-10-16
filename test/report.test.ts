import { describe, expect, test } from "vitest";
import { renderBatch, renderConsent, renderJob, renderResearch, type BatchRecord, type JobRecord } from "../src/report.js";

// Golden renderings (spec D5–D7, D9). Where the D5 text conflicts with D3's written rules, D3 wins and the comment says how.

const FLASH = "opencode-go/deepseek-v4.1-flash";
const job = (r: Partial<JobRecord> & Pick<JobRecord, "job" | "status">): JobRecord => ({
  format: "cheapag/1", landed: false, steps: "1", summary: "", changed: [], risks: [], review: [], missing: [], worktree: null,
  usage: { turns: 0, costUsd: 0 }, selfFix: 0, models: { requested: FLASH, final: FLASH, escalated: false }, ...r,
});
const block = (...lines: string[]) => lines.join("\n");
const ch = (status: string, path: string, add: number, del = 0) => ({ status, path, add, del });

// headline counts come from changed[]; D5 shows no changed: section for these, D3 renders it because it is non-empty
const TWO_FILES = [ch("M", "src/api/login.ts", 28, 3), ch("M", "test/login.test.ts", 3)];

describe("D5 status blocks", () => {
  test("OK", () => {
    expect(renderJob(job({
      job: "j7f3a", status: "OK", landed: true, steps: "1-2", tests: "pass", usage: { turns: 22, costUsd: 0.014 },
      summary: "sliding-window redis limiter + 5/min/IP on POST /api/login with 429 + Retry-After",
      changed: [ch("A", "src/lib/rateLimit.ts", 58), ch("A", "test/rateLimit.test.ts", 41), ch("M", "src/api/login.ts", 9, 3), ch("M", "test/login.test.ts", 18)],
      risks: ["IP taken from req.ip; behind a proxy needs trust-proxy setting"],
      review: [{ path: "src/lib/rateLimit.ts", start: 12, end: 34 }, { path: "src/api/login.ts", start: 20, end: 29 }],
      missing: ["ignored for OK"], tried: ["fix 1: ignored for OK → passed"],
    }))).toBe(block(
      "OK j7f3a step=1-2 files=4 +126/-3 tests=pass turns=22 cost=$0.014",
      "summary: sliding-window redis limiter + 5/min/IP on POST /api/login with 429 + Retry-After",
      "changed:",
      "  A src/lib/rateLimit.ts +58",
      "  A test/rateLimit.test.ts +41",
      "  M src/api/login.ts +9 -3",
      "  M test/login.test.ts +18",
      "risks:",
      "  - IP taken from req.ip; behind a proxy needs trust-proxy setting",
      "review: src/lib/rateLimit.ts:12-34, src/api/login.ts:20-29",
      "log: .cheapag/jobs/j7f3a/",
    ));
  });

  test("PARTIAL", () => {
    expect(renderJob(job({
      job: "j2b7d", status: "PARTIAL", steps: "5", tests: "pass", usage: { turns: 40, costUsd: 0.019 },
      summary: "migrated 7 of 11 handlers to new error type",
      changed: [ch("M", "src/api/users.ts", 30, 4), ch("M", "src/api/orders.ts", 28, 3), ch("M", "src/api/items.ts", 30, 3)],
      missing: ["src/api/{auth,billing,admin,search}.ts not migrated (turn cap)"], worktree: ".cheapag/worktrees/j2b7d",
    }))).toBe(block(
      "PARTIAL j2b7d step=5 files=3 +88/-10 tests=pass turns=40 cost=$0.019",
      "summary: migrated 7 of 11 handlers to new error type",
      "changed:",
      "  M src/api/users.ts +30 -4",
      "  M src/api/orders.ts +28 -3",
      "  M src/api/items.ts +30 -3",
      "missing:",
      "  - src/api/{auth,billing,admin,search}.ts not migrated (turn cap)",
      "worktree: .cheapag/worktrees/j2b7d/",
      "log: .cheapag/jobs/j2b7d/",
    ));
  });

  test("FAIL: D3 puts cost= before fix/esc/model and review: before error:/tried:", () => {
    expect(renderJob(job({
      job: "j4e1c", status: "FAIL", steps: "2", tests: "fail", usage: { turns: 29, costUsd: 0.031 }, selfFix: 2,
      models: { requested: FLASH, final: "opencode-go/deepseek-v4-pro", escalated: true },
      summary: "added limiter middleware to login route", changed: TWO_FILES,
      error: ["`npm test -- login`", "  ✗ login › 6th request returns 429", "    expected 429, received 200", "    at test/login.test.ts:44"],
      tried: [
        "fix 1: moved middleware before body parser → same failure",
        "fix 2: keyed by req.ip instead of header → same failure",
        "esc: v4-pro rewrote route registration → same failure",
      ],
      review: [{ path: "src/api/login.ts", start: 12, end: 30 }], worktree: ".cheapag/worktrees/j4e1c",
    }))).toBe(block(
      "FAIL j4e1c step=2 files=2 +31/-3 tests=fail turns=29 cost=$0.031 fix=2 esc=1 model=opencode-go/deepseek-v4-pro",
      "summary: added limiter middleware to login route",
      "changed:",
      "  M src/api/login.ts +28 -3",
      "  M test/login.test.ts +3",
      "review: src/api/login.ts:12-30",
      "error: `npm test -- login`",
      "  ✗ login › 6th request returns 429",
      "    expected 429, received 200",
      "    at test/login.test.ts:44",
      "tried:",
      "  - fix 1: moved middleware before body parser → same failure",
      "  - fix 2: keyed by req.ip instead of header → same failure",
      "  - esc: v4-pro rewrote route registration → same failure",
      "worktree: .cheapag/worktrees/j4e1c/",
      "log: .cheapag/jobs/j4e1c/",
    ));
  });

  test("FAIL with a reason (worker error, dependency failed)", () => {
    expect(renderJob(job({
      job: "j5f2a", status: "FAIL", steps: "3", tests: "none", usage: { turns: 2, costUsd: 0.001 },
      summary: "(worker gave no summary)", reason: "needs 1 (FAIL)",
    }))).toBe(block(
      "FAIL j5f2a step=3 files=0 +0/-0 tests=none turns=2 cost=$0.001",
      "summary: (worker gave no summary)",
      "reason: needs 1 (FAIL)",
      "log: .cheapag/jobs/j5f2a/",
    ));
  });

  test("BLOCKED: no tests= when verify never ran, files counted but not listed; options lettered a)–d)", () => {
    expect(renderJob(job({
      job: "j6a90", status: "BLOCKED", steps: "2", usage: { turns: 9, costUsd: 0.004 }, changed: [ch("A", "src/middleware/rateLimit.ts", 12)],
      worktree: ".cheapag/worktrees/j6a90",
      question: {
        text: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
        options: ["run before lockout (counts all attempts)", "run after lockout (counts only non-locked users)", "replace lockout entirely"],
      },
    }))).toBe(block(
      "BLOCKED j6a90 step=2 files=1 +12/-0 turns=9 cost=$0.004", // files counted, not listed (D5)
      "question: login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
      "options:",
      "  a) run before lockout (counts all attempts)",
      "  b) run after lockout (counts only non-locked users)",
      "  c) replace lockout entirely",
      "log: .cheapag/jobs/j6a90/",
    ));
  });

  test("BLOCKED on a dependency: a question without options", () => {
    expect(renderJob(job({
      job: "j6a93", status: "BLOCKED", usage: { turns: 3, costUsd: 0.001 },
      question: { text: 'step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.', options: [] },
    }))).toBe(block(
      "BLOCKED j6a93 step=1 files=0 +0/-0 turns=3 cost=$0.001",
      'question: step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.',
      "log: .cheapag/jobs/j6a93/",
    ));
  });

  test("CONFLICT", () => {
    expect(renderJob(job({
      job: "j3d55", status: "CONFLICT", steps: "3", tests: "pass", usage: { turns: 11, costUsd: 0.009 }, redo: 1,
      changed: [ch("M", "src/api/login.ts", 14, 4), ch("A", "test/limit.test.ts", 6)], worktree: ".cheapag/worktrees/j3d55",
      conflict: ["src/api/login.ts (also changed by j3d54, landed first; redo could not reconcile)"],
    }))).toBe(block(
      "CONFLICT j3d55 step=3 files=2 +20/-4 tests=pass turns=11 cost=$0.009 redo=1",
      "changed:",
      "  M src/api/login.ts +14 -4",
      "  A test/limit.test.ts +6",
      "conflict:",
      "  src/api/login.ts (also changed by j3d54, landed first; redo could not reconcile)",
      "worktree: .cheapag/worktrees/j3d55/",
      "log: .cheapag/jobs/j3d55/",
    ));
  });

  test("BUDGET", () => {
    expect(renderJob(job({
      job: "j9q2w", status: "BUDGET", steps: "4", usage: { turns: 18, costUsd: 0.006 },
      changed: [ch("A", "src/a.ts", 30), ch("A", "src/b.ts", 10)], worktree: ".cheapag/worktrees/j9q2w",
      reason: "Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus, glm-5.3 (resets ~16:40)",
    }))).toBe(block(
      "BUDGET j9q2w step=4 files=2 +40/-0 turns=18 cost=$0.006",
      "changed:",
      "  A src/a.ts +30",
      "  A src/b.ts +10",
      "reason: Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus, glm-5.3 (resets ~16:40)",
      "worktree: .cheapag/worktrees/j9q2w/",
      "log: .cheapag/jobs/j9q2w/",
    ));
  });

  test("TIMEOUT: reason, missing, worktree", () => {
    expect(renderJob(job({
      job: "j1t0a", status: "TIMEOUT", steps: "6", tests: "none", usage: { turns: 31, costUsd: 0.012 },
      summary: "half the handlers migrated", missing: ["src/api/admin.ts"], reason: "20-minute job cap hit",
      worktree: ".cheapag/worktrees/j1t0a",
    }))).toBe(block(
      "TIMEOUT j1t0a step=6 files=0 +0/-0 tests=none turns=31 cost=$0.012",
      "summary: half the handlers migrated",
      "reason: 20-minute job cap hit",
      "missing:",
      "  - src/api/admin.ts",
      "worktree: .cheapag/worktrees/j1t0a/",
      "log: .cheapag/jobs/j1t0a/",
    ));
  });

  test("CANCELLED", () => {
    expect(renderJob(job({
      job: "j0c1d", status: "CANCELLED", usage: { turns: 4, costUsd: 0.002 }, reason: "server restarted while the job was running",
      worktree: ".cheapag/worktrees/j0c1d",
    }))).toBe(block(
      "CANCELLED j0c1d step=1 files=0 +0/-0 turns=4 cost=$0.002",
      "reason: server restarted while the job was running",
      "worktree: .cheapag/worktrees/j0c1d/",
      "log: .cheapag/jobs/j0c1d/",
    ));
  });

  test("RUNNING is one line", () => {
    expect(renderJob(job({ job: "j6a91", status: "RUNNING", summary: "ignored", usage: { turns: 14, costUsd: 0.003 } })))
      .toBe("RUNNING j6a91 step=1 turns=14");
  });

  test("CONSENT", () => {
    expect(renderConsent({
      repo: "cheapAg",
      send: "code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
      retention: "deepseek-*, qwen-* = zero retention; glm-5.3, kimi-k3 = not stated",
      approve: "ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only",
    })).toBe(block(
      "CONSENT repo=cheapAg",
      "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
      "retention: deepseek-*, qwen-* = zero retention; glm-5.3, kimi-k3 = not stated",
      "approve: ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only",
    ));
  });
});

describe("optional headline tokens", () => {
  const base = { job: "j1", status: "OK" as const, tests: "pass" as const, usage: { turns: 1, costUsd: 0.0004 } };
  test.each([
    ["none", {}, ""],
    ["fix", { selfFix: 1 }, " fix=1"],
    ["esc + model", { selfFix: 2, models: { requested: FLASH, final: "x/pro", escalated: true } }, " fix=2 esc=1 model=x/pro"],
    ["model alone (fallback)", { models: { requested: FLASH, final: "x/qwen", escalated: false } }, " model=x/qwen"],
    ["redo", { redo: 1 }, " redo=1"],
    ["billing", { billing: "zen" as const }, " billing=zen"],
    ["all, in D3 order", { selfFix: 1, models: { requested: FLASH, final: "x/pro", escalated: true }, redo: 1, billing: "zen" as const }, " fix=1 esc=1 model=x/pro redo=1 billing=zen"],
  ])("%s", (_, extra, tokens) => {
    expect(renderJob(job({ ...base, ...extra })).split("\n")[0]).toBe(`OK j1 step=1 files=0 +0/-0 tests=pass turns=1 cost=$0.000${tokens}`);
  });
});

describe("D7 research block", () => {
  const answer = [
    "JWT is validated in src/middleware/auth.ts:18-42 (verifyToken), called for all /api/* routes",
    "from src/app.ts:31. Expired tokens throw TokenExpiredError, mapped to 401 in",
    "src/middleware/errors.ts:12. Refresh is client-side only; no server refresh endpoint.",
  ];
  test("ANSWER with refs, confidence and the unlanded-jobs note", () => {
    expect(renderResearch({
      format: "cheapag/1", job: "r5k2q", status: "ANSWER", filesRead: 9, usage: { turns: 11, costUsd: 0.003 },
      answer: answer.join("\n"), confidence: "high", unlanded: ["j6a91", "j6a92"],
      refs: [{ path: "src/middleware/auth.ts", start: 18, end: 42 }, { path: "src/app.ts", start: 31, end: 31 }, { path: "src/middleware/errors.ts", start: 12, end: 12 }],
    })).toBe(block(
      "ANSWER r5k2q files_read=9 turns=11 cost=$0.003",
      ...answer,
      "refs: src/middleware/auth.ts:18-42, src/app.ts:31, src/middleware/errors.ts:12",
      "confidence: high",
      "note: 2 jobs not yet landed (j6a91, j6a92); their changes are not visible to research",
      "log: .cheapag/jobs/r5k2q/",
    ));
  });
  test("UNSURE on a fallback model, no note when everything landed", () => {
    expect(renderResearch({
      format: "cheapag/1", job: "r1", status: "UNSURE", filesRead: 3, usage: { turns: 4, costUsd: 0.001 },
      models: { requested: "a/flash", final: "a/flash2" }, answer: "No refresh endpoint found.", refs: [], confidence: "low", unlanded: [],
    })).toBe(block(
      "UNSURE r1 files_read=3 turns=4 cost=$0.001 model=a/flash2",
      "No refresh endpoint found.",
      "confidence: low",
      "log: .cheapag/jobs/r1/",
    ));
  });
  test("FAIL with a reason", () => {
    expect(renderResearch({
      format: "cheapag/1", job: "r2", status: "FAIL", filesRead: 0, usage: { turns: 0, costUsd: 0 }, answer: "", refs: [],
      reason: "worker error: upstream 500", unlanded: ["j1"],
    })).toBe(block(
      "FAIL r2 files_read=0 turns=0 cost=$0.000",
      "reason: worker error: upstream 500",
      "note: 1 job not yet landed (j1); their changes are not visible to research",
      "log: .cheapag/jobs/r2/",
    ));
  });
});

describe("D6 batch blocks", () => {
  const batch = (b: Partial<BatchRecord>): BatchRecord => ({ format: "cheapag/1", batch: "b4k1x", groups: ["1", "2", "3"], notes: [], integration: "pending", jobs: [], ...b });
  const blocked = job({
    job: "j6a90", status: "BLOCKED", steps: "2", usage: { turns: 9, costUsd: 0.004 },
    question: { text: "Rate limit should:", options: ["run before lockout", "run after lockout"] },
  });

  test("early return: BLOCKED first, RUNNING as adjacent single lines, next:", () => {
    const running = [
      job({ job: "j6a91", status: "RUNNING", steps: "1", usage: { turns: 14, costUsd: 0.003 } }),
      job({ job: "j6a92", status: "RUNNING", steps: "3", usage: { turns: 3, costUsd: 0.002 } }),
    ];
    expect(renderBatch(batch({}), [running[0], blocked, running[1]])).toBe(block(
      "BATCH b4k1x groups=3 BLOCKED=1 RUNNING=2 landed=0 integration=pending cost=$0.009",
      "BLOCKED j6a90 step=2 files=0 +0/-0 turns=9 cost=$0.004",
      "question: Rate limit should:",
      "options:",
      "  a) run before lockout",
      "  b) run after lockout",
      "log: .cheapag/jobs/j6a90/",
      "",
      "RUNNING j6a91 step=1 turns=14",
      "RUNNING j6a92 step=3 turns=3",
      'next: reply(job="j6a90", ...) then jobs(action="wait", job="b4k1x")',
    ));
  });

  test("completed: note, OK blocks separated by blank lines, no next:", () => {
    const ok = (id: string, steps: string, summary: string, cost: number, review: JobRecord["review"] = []) =>
      job({ job: id, status: "OK", landed: true, steps, tests: "pass", summary, review, usage: { turns: 5, costUsd: cost } });
    expect(renderBatch(batch({ integration: "pass", notes: ["steps 2,3 serialized (src/api/login.ts)"] }), [
      ok("j6a90", "2", "limiter runs before lockout on POST /api/login", 0.01, [{ path: "src/api/login.ts", start: 12, end: 30 }]),
      ok("j6a91", "1", "sliding-window redis limiter with tests", 0.013),
      ok("j6a92", "3", "documented 429 + Retry-After under /api/login", 0.004),
    ])).toBe(block(
      "BATCH b4k1x groups=3 OK=3 landed=3 integration=pass cost=$0.027",
      "note: steps 2,3 serialized (src/api/login.ts)",
      "OK j6a90 step=2 files=0 +0/-0 tests=pass turns=5 cost=$0.010",
      "summary: limiter runs before lockout on POST /api/login",
      "review: src/api/login.ts:12-30",
      "log: .cheapag/jobs/j6a90/",
      "",
      "OK j6a91 step=1 files=0 +0/-0 tests=pass turns=5 cost=$0.013",
      "summary: sliding-window redis limiter with tests",
      "log: .cheapag/jobs/j6a91/",
      "",
      "OK j6a92 step=3 files=0 +0/-0 tests=pass turns=5 cost=$0.004",
      "summary: documented 429 + Retry-After under /api/login",
      "log: .cheapag/jobs/j6a92/",
    ));
  });

  test("wait=false: RUNNING only", () => {
    expect(renderBatch(batch({ batch: "b7m2p", groups: ["4", "5"] }), [
      job({ job: "j7m20", status: "RUNNING", steps: "4" }),
      job({ job: "j7m21", status: "RUNNING", steps: "5" }),
    ])).toBe(block(
      "BATCH b7m2p groups=2 RUNNING=2 landed=0 integration=pending cost=$0.000",
      "RUNNING j7m20 step=4 turns=0",
      "RUNNING j7m21 step=5 turns=0",
      'next: jobs(action="wait", job="b7m2p")',
    ));
  });

  test("urgency order and counts; integration failure shows its error: after the header", () => {
    const s = (id: string, status: JobRecord["status"]) => job({ job: id, status, landed: status === "OK", usage: { turns: 1, costUsd: 0.001 } });
    const text = renderBatch(batch({ integration: "fail", groups: ["1", "2", "3", "4", "5", "6", "7"], integrationError: ["`npm test`", "  ✗ suite broke"] }), [
      s("j1", "OK"), s("j2", "PARTIAL"), s("j3", "TIMEOUT"), s("j4", "FAIL"), s("j5", "CONFLICT"), s("j6", "BUDGET"), s("j7", "CANCELLED"),
    ]);
    const lines = text.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "BATCH b4k1x groups=7 CONFLICT=1 FAIL=1 BUDGET=1 TIMEOUT=1 CANCELLED=1 PARTIAL=1 OK=1 landed=1 integration=fail cost=$0.007",
      "error: `npm test`",
      "  ✗ suite broke",
    ]);
    // BUDGET, TIMEOUT and CANCELLED share a rank and keep their input order
    expect(lines.filter((l) => /^[A-Z]+ j\d /.test(l)).map((l) => l.split(" ")[1])).toEqual(["j5", "j4", "j3", "j6", "j7", "j2", "j1"]);
    expect(text).not.toContain("next:");
  });

  test("a failing integration check: error: after the header, then the fix job's block, then the groups; its cost counts", () => {
    const ok = (id: string, steps: string) => job({ job: id, status: "OK", landed: true, steps, tests: "none", usage: { turns: 2, costUsd: 0.001 } });
    const fix = job({
      job: "j9f00", status: "FAIL", steps: "1,2", tests: "fail", usage: { turns: 6, costUsd: 0.002 }, worktree: ".cheapag/worktrees/j9f00",
      error: ["`npm test`", "  ✗ login uses renamed helper"], tried: ["fix 1: renamed call → same failure"],
    });
    expect(renderBatch(batch({ groups: ["1", "2"], integration: "fail", integrationError: ["`npm test`", "  ✗ login uses renamed helper"], fix: "j9f00" }), [ok("j1", "1"), ok("j2", "2")], fix)).toBe(block(
      "BATCH b4k1x groups=2 OK=2 landed=2 integration=fail cost=$0.004",
      "error: `npm test`",
      "  ✗ login uses renamed helper",
      "FAIL j9f00 step=1,2 files=0 +0/-0 tests=fail turns=6 cost=$0.002",
      "error: `npm test`",
      "  ✗ login uses renamed helper",
      "tried:",
      "  - fix 1: renamed call → same failure",
      "worktree: .cheapag/worktrees/j9f00/",
      "log: .cheapag/jobs/j9f00/",
      "",
      "OK j1 step=1 files=0 +0/-0 tests=none turns=2 cost=$0.001",
      "log: .cheapag/jobs/j1/",
      "",
      "OK j2 step=2 files=0 +0/-0 tests=none turns=2 cost=$0.001",
      "log: .cheapag/jobs/j2/",
    ));
  });

  test("integration states: running while the check or fix job runs (the fix job as one RUNNING line), none without a command", () => {
    const ok = job({ job: "j1", status: "OK", landed: true, steps: "1" });
    expect(renderBatch(batch({ groups: ["1"], integration: "running", fix: "j9f00" }), [ok], job({ job: "j9f00", status: "RUNNING", steps: "1", usage: { turns: 3, costUsd: 0 } })))
      .toBe(block(
        "BATCH b4k1x groups=1 OK=1 landed=1 integration=running cost=$0.000",
        "RUNNING j9f00 step=1 turns=3",
        "",
        "OK j1 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "log: .cheapag/jobs/j1/",
        'next: jobs(action="wait", job="b4k1x")',
      ));
    expect(renderBatch(batch({ groups: ["1"], integration: "none" }), [ok]).split("\n")[0]).toBe("BATCH b4k1x groups=1 OK=1 landed=1 integration=none cost=$0.000");
  });
});

describe("D9 budget and truncation", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ch("M", `src/module${String(i).padStart(2, "0")}/index.ts`, 1));
  const long = (tag: string, n: number) => `${tag} ${"x".repeat(n - tag.length - 1)}`;

  test("a block within budget is untouched (changed capped at 15)", () => {
    const text = renderJob(job({ job: "j1", status: "OK", landed: true, summary: "s", changed: files(16) }), 1000);
    expect(text).toContain("\n  M src/module14/index.ts +1\n  … +1 more\nlog:");
  });

  test("cuts only as far as needed: changed → 5 is enough here", () => {
    const r = job({ job: "j1", status: "OK", landed: true, summary: "s", changed: files(15), risks: ["a", "b", "c", "d"] });
    const text = renderJob(r, 110);
    expect(text.length / 4).toBeLessThanOrEqual(110);
    expect(renderJob(r).length / 4).toBeGreaterThan(110); // uncut at the default 400
    expect(text).toBe(block(
      "OK j1 step=1 files=15 +15/-0 turns=0 cost=$0.000",
      "summary: s",
      "changed:",
      ...files(5).map((c) => `  M ${c.path} +1`),
      "  … +10 more",
      "risks:",
      "  - a", "  - b", "  - c", "  - d",
      "log: .cheapag/jobs/j1/",
    ));
  });

  test("full order on a FAIL: changed → 5, tried → last, risks → 3, review → 3, error → 12-line floor, summary → 100; never-cut sections stay", () => {
    const error = ["`npm test`", ...Array.from({ length: 24 }, (_, i) => `  ${long(`✗ failure ${i}`, 150)}`)];
    const text = renderJob(job({
      job: "j9", status: "FAIL", tests: "fail", summary: long("summary", 160), changed: files(20),
      risks: [1, 2, 3, 4, 5].map((i) => long(`risk ${i}`, 120)),
      review: [1, 2, 3, 4, 5].map((i) => ({ path: `src/module0${i}/index.ts`, start: 1, end: 9 })),
      tried: ["fix 1: a → same failure", "fix 2: b → same failure", "esc: c → same failure"],
      error, reason: "worker error: upstream 500", worktree: ".cheapag/worktrees/j9",
    }));
    const lines = text.split("\n");
    expect(lines[1]).toBe(`summary: ${long("summary", 160).slice(0, 99)}…`);
    expect(text).toContain("\n  … +15 more\nrisks:\n");
    expect(lines.filter((l) => l.startsWith("  - risk"))).toHaveLength(3);
    expect(text).toContain("\nreview: src/module01/index.ts:1-9, src/module02/index.ts:1-9, src/module03/index.ts:1-9\nerror:");
    const errorLines = lines.slice(lines.findIndex((l) => l.startsWith("error:")), lines.indexOf("tried:"));
    expect(errorLines).toHaveLength(12);
    expect(errorLines.at(-1)).toBe("  … +14 more lines (see log)");
    expect(text.endsWith(block(
      "tried:",
      "  - esc: c → same failure",
      "reason: worker error: upstream 500",
      "worktree: .cheapag/worktrees/j9/",
      "log: .cheapag/jobs/j9/",
    ))).toBe(true);
  });

  test("error is cut only as far as the budget needs, never below 12 lines", () => {
    const error = ["`npm test`", ...Array.from({ length: 24 }, (_, i) => `  ✗ failure ${i} ${"y".repeat(40)}`)];
    const text = renderJob(job({ job: "j8", status: "FAIL", tests: "fail", summary: "s", error }), 250);
    const lines = text.split("\n");
    const errorLines = lines.slice(lines.findIndex((l) => l.startsWith("error:")), lines.indexOf("log: .cheapag/jobs/j8/"));
    expect(text.length / 4).toBeLessThanOrEqual(250);
    expect(errorLines.length).toBeGreaterThan(12);
    expect(errorLines.length).toBeLessThan(25);
  });

  test("golden: several questions, numbered, each with its own lettered options, within the default budget", () => {
    const text = renderJob(job({
      job: "j6a90", status: "BLOCKED", steps: "2", usage: { turns: 4, costUsd: 0.002 }, question: null,
      questions: [
        { text: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:", options: ["run before lockout (counts all attempts)", "run after lockout (counts only non-locked users)", "replace lockout entirely"] },
        { text: "Where should the counters live?", options: ["in memory (per process)", "redis (shared across instances)"] },
        { text: "Name the config key for the limit", options: [] },
      ],
    }));
    expect(text).toBe(block(
      "BLOCKED j6a90 step=2 files=0 +0/-0 turns=4 cost=$0.002",
      "question 1: login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
      "options:",
      "  a) run before lockout (counts all attempts)",
      "  b) run after lockout (counts only non-locked users)",
      "  c) replace lockout entirely",
      "question 2: Where should the counters live?",
      "options:",
      "  a) in memory (per process)",
      "  b) redis (shared across instances)",
      "question 3: Name the config key for the limit",
      "log: .cheapag/jobs/j6a90/",
    ));
    expect(text.length / 4).toBeLessThanOrEqual(250);
  });

  test("never cut: several long questions and all their options survive an over-budget block", () => {
    const qs = [1, 2].map((n) => ({ text: long(`question${n}`, 300), options: ["a", "b", "c", "d"].map((x) => long(`option ${n}${x}`, 150)) }));
    const text = renderJob(job({ job: "j7", status: "BLOCKED", risks: ["r".repeat(100)], question: null, questions: qs }));
    for (const [i, q] of qs.entries()) {
      expect(text).toContain(`\nquestion ${i + 1}: ${q.text}\n`);
      for (const o of q.options) expect(text).toContain(`) ${o}\n`);
    }
  });

  test("never cut: a long question and all options survive an over-budget block", () => {
    const options = ["a", "b", "c", "d"].map((x) => long(`option ${x}`, 300));
    const text = renderJob(job({ job: "j7", status: "BLOCKED", question: { text: long("question", 400), options } }));
    expect(text).toContain(`\nquestion: ${long("question", 400)}\n`);
    for (const o of options) expect(text).toContain(`) ${o}\n`);
  });
});

describe("D9 line rules", () => {
  test("lines over 200 chars are middle-elided; tabs become 2 spaces; multi-line fields become one line", () => {
    const text = renderJob(job({
      job: "j1", status: "FAIL", summary: "first\n  second", reason: `start ${"r".repeat(300)} end`,
      error: ["`cmd`", "\tindented by a tab"], risks: ["one\ntwo"],
    }));
    const reason = text.split("\n").find((l) => l.startsWith("reason:"))!;
    expect(reason).toHaveLength(200);
    expect(reason).toMatch(/^reason: start r+…r+ end$/);
    expect(text).toContain("\nsummary: first second\n");
    expect(text).toContain("\n  - one two\n");
    expect(text).toContain("\n  indented by a tab\n");
    expect(text).not.toContain("\t");
  });
});
