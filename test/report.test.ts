import { describe, expect, test } from "vitest";
import {
  failBlock,
  NO_SUMMARY,
  permissionOptions,
  renderBatch,
  renderConsent,
  renderJob,
  renderResearch,
  type BatchRecord,
  type JobRecord,
  type PermissionBlock,
} from "../src/report.js";

// Golden renderings (spec D5–D7, D9). Where the D5 text conflicts with D3's written rules, D3 wins and the comment says how.

const FLASH = "opencode-go/deepseek-v4.1-flash";
const job = (r: Partial<JobRecord> & Pick<JobRecord, "job" | "status">): JobRecord => ({
  format: "cheapag/1",
  landed: false,
  steps: "1",
  summary: "",
  changed: [],
  risks: [],
  review: [],
  missing: [],
  worktree: null,
  usage: { turns: 0, costUsd: 0 },
  selfFix: 0,
  models: { requested: FLASH, final: FLASH, escalated: false },
  ...r,
});
const block = (...lines: string[]) => lines.join("\n");
const ch = (status: string, path: string, add: number, del = 0) => ({ status, path, add, del });

// headline counts come from changed[]; D5 shows no changed: section for these, D3 renders it because it is non-empty
const TWO_FILES = [ch("M", "src/api/login.ts", 28, 3), ch("M", "test/login.test.ts", 3)];

test.each(["ANSWER", "FAIL"] as const)(
  "%s reports a retained research worktree separately from its worker result",
  (status) => {
    const record = {
      format: "cheapag/1" as const,
      job: "rbusy",
      status,
      filesRead: 1,
      usage: { turns: 2, costUsd: 0 },
      answer: status === "ANSWER" ? "useful answer" : "",
      refs: [],
      unlanded: [],
      reason: status === "FAIL" ? "worker error: API rejected request (400)" : undefined,
      cleanupError: "EBUSY: resource busy or locked",
      worktree: ".cheapag/worktrees/rbusy",
    };
    const text = renderResearch(record);
    expect(text).toContain(`cleanup error: ${record.cleanupError}`);
    expect(text).toContain("worktree: .cheapag/worktrees/rbusy/\nlog: .cheapag/jobs/rbusy/");
    if (status === "FAIL") expect(text).toContain(`reason: ${record.reason}`);
    else expect(text).toContain("notes:\nuseful answer");
  },
);

describe("D5 status blocks", () => {
  test("found: (ticket 29) sits after error: and before tried: on FAIL, first on PARTIAL; a long note wraps at 200 chars and is never cut", () => {
    const note = `src/a.ts:parse drops the last token; ${"ruled out the lexer ".repeat(15).trim()}.`;
    const fail = renderJob(
      job({
        job: "j1",
        status: "FAIL",
        tests: "fail",
        error: ["`npm test`"],
        found: note,
        tried: ["fix 1: x → same failure"],
        reason: "no reproduction test by turn 12",
      }),
      60,
    );
    const lines = fail.split("\n");
    const at = lines.findIndex((l) => l.startsWith("found: "));
    expect(lines[at - 1]).toBe("error: `npm test`");
    expect(lines.slice(at, lines.indexOf("tried:")).join(" ")).toBe(`found: ${note}`);
    expect(lines.slice(at, lines.indexOf("tried:")).every((l) => l.length <= 200)).toBe(true);
    const partial = renderJob(
      job({
        job: "j2",
        status: "PARTIAL",
        found: "a.ts:f",
        missing: ["the test"],
        worktree: ".cheapag/worktrees/j2",
      }),
    );
    expect(partial).toContain("\nfound: a.ts:f\nmissing:\n");
    expect(renderJob(job({ job: "j3", status: "OK", found: "ignored" }))).not.toContain("found:");
  });

  test("found: leads the block when the worker gave no summary (the summary: line is omitted); with a summary the order is unchanged", () => {
    const none = renderJob(
      job({
        job: "j8",
        status: "FAIL",
        summary: "(worker gave no summary)",
        error: ["`npm test`"],
        found: "a.ts:f",
        reason: "turn cap",
      }),
    ).split("\n");
    expect(none.slice(1, 4)).toEqual(["found: a.ts:f", "error: `npm test`", "reason: turn cap"]);
    expect(none.join("\n")).not.toContain("summary:");
    const partial = renderJob(
      job({
        job: "j9",
        status: "PARTIAL",
        summary: "(worker gave no summary)",
        found: "a.ts:f",
        missing: ["x"],
      }),
    ).split("\n");
    expect(partial.slice(1, 3)).toEqual(["found: a.ts:f", "missing:"]);
    const kept = renderJob(
      job({ job: "j10", status: "FAIL", summary: "did x", error: ["`npm test`"], found: "a.ts:f" }),
    ).split("\n");
    expect(kept.slice(1, 4)).toEqual(["summary: did x", "error: `npm test`", "found: a.ts:f"]);
  });

  test("OK", () => {
    expect(
      renderJob(
        job({
          job: "j7f3a",
          status: "OK",
          landed: true,
          steps: "1-2",
          tests: "pass",
          usage: { turns: 22, costUsd: 0.014 },
          summary:
            "sliding-window redis limiter + 5/min/IP on POST /api/login with 429 + Retry-After",
          changed: [
            ch("A", "src/lib/rateLimit.ts", 58),
            ch("A", "test/rateLimit.test.ts", 41),
            ch("M", "src/api/login.ts", 9, 3),
            ch("M", "test/login.test.ts", 18),
          ],
          risks: ["IP taken from req.ip; behind a proxy needs trust-proxy setting"],
          review: [
            { path: "src/lib/rateLimit.ts", start: 12, end: 34 },
            { path: "src/api/login.ts", start: 20, end: 29 },
          ],
          missing: ["ignored for OK"],
          tried: ["fix 1: ignored for OK → passed"],
        }),
      ),
    ).toBe(
      block(
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
      ),
    );
  });

  test("PARTIAL", () => {
    expect(
      renderJob(
        job({
          job: "j2b7d",
          status: "PARTIAL",
          steps: "5",
          tests: "pass",
          usage: { turns: 40, costUsd: 0.019 },
          summary: "migrated 7 of 11 handlers to new error type",
          changed: [
            ch("M", "src/api/users.ts", 30, 4),
            ch("M", "src/api/orders.ts", 28, 3),
            ch("M", "src/api/items.ts", 30, 3),
          ],
          missing: ["src/api/{auth,billing,admin,search}.ts not migrated (turn cap)"],
          worktree: ".cheapag/worktrees/j2b7d",
        }),
      ),
    ).toBe(
      block(
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
      ),
    );
  });

  test("FAIL: D3 puts cost= before fix/esc/model and review: before error:/tried:", () => {
    expect(
      renderJob(
        job({
          job: "j4e1c",
          status: "FAIL",
          steps: "2",
          tests: "fail",
          usage: { turns: 29, costUsd: 0.031 },
          selfFix: 2,
          models: { requested: FLASH, final: "opencode-go/deepseek-v4-pro", escalated: true },
          summary: "added limiter middleware to login route",
          changed: TWO_FILES,
          error: [
            "`npm test -- login`",
            "  ✗ login › 6th request returns 429",
            "    expected 429, received 200",
            "    at test/login.test.ts:44",
          ],
          tried: [
            "fix 1: moved middleware before body parser → same failure",
            "fix 2: keyed by req.ip instead of header → same failure",
            "esc: v4-pro rewrote route registration → same failure",
          ],
          review: [{ path: "src/api/login.ts", start: 12, end: 30 }],
          worktree: ".cheapag/worktrees/j4e1c",
        }),
      ),
    ).toBe(
      block(
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
      ),
    );
  });

  test("FAIL check=env: the check could not run, so error: leads with the environment line (ticket 33)", () => {
    expect(
      renderJob(
        job({
          job: "j7e1n",
          status: "FAIL",
          steps: "1",
          tests: "fail",
          usage: { turns: 3, costUsd: 0.001 },
          check: "env",
          error: [
            "exit 127: command not found",
            "`nonexistent-cmd-xyz`",
            "  sh: nonexistent-cmd-xyz: command not found",
          ],
          worktree: ".cheapag/worktrees/j7e1n",
        }),
      ),
    ).toBe(
      block(
        "FAIL j7e1n step=1 files=0 +0/-0 tests=fail check=env turns=3 cost=$0.001",
        "error: environment: the check could not run (exit 127: command not found)",
        "`nonexistent-cmd-xyz`",
        "  sh: nonexistent-cmd-xyz: command not found",
        "worktree: .cheapag/worktrees/j7e1n/",
        "log: .cheapag/jobs/j7e1n/",
      ),
    );
  });

  test("FAIL with a reason (worker error, dependency failed)", () => {
    expect(
      renderJob(
        job({
          job: "j5f2a",
          status: "FAIL",
          steps: "3",
          tests: "none",
          usage: { turns: 2, costUsd: 0.001 },
          summary: "(worker gave no summary)",
          reason: "needs 1 (FAIL)",
        }),
      ),
    ).toBe(
      block(
        "FAIL j5f2a step=3 files=0 +0/-0 tests=none turns=2 cost=$0.001",
        "summary: (worker gave no summary)",
        "reason: needs 1 (FAIL)",
        "log: .cheapag/jobs/j5f2a/",
      ),
    );
  });

  test("BLOCKED: no tests= when verify never ran, files counted but not listed; options lettered a)–d)", () => {
    expect(
      renderJob(
        job({
          job: "j6a90",
          status: "BLOCKED",
          steps: "2",
          usage: { turns: 9, costUsd: 0.004 },
          changed: [ch("A", "src/middleware/rateLimit.ts", 12)],
          worktree: ".cheapag/worktrees/j6a90",
          question: {
            text: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
            options: [
              "run before lockout (counts all attempts)",
              "run after lockout (counts only non-locked users)",
              "replace lockout entirely",
            ],
          },
        }),
      ),
    ).toBe(
      block(
        "BLOCKED j6a90 step=2 files=1 +12/-0 turns=9 cost=$0.004", // files counted, not listed (D5)
        "question: login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
        "options:",
        "  a) run before lockout (counts all attempts)",
        "  b) run after lockout (counts only non-locked users)",
        "  c) replace lockout entirely",
        "log: .cheapag/jobs/j6a90/",
      ),
    );
  });

  test("BLOCKED on a dependency: a question without options", () => {
    expect(
      renderJob(
        job({
          job: "j6a93",
          status: "BLOCKED",
          usage: { turns: 3, costUsd: 0.001 },
          question: {
            text: 'step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.',
            options: [],
          },
        }),
      ),
    ).toBe(
      block(
        "BLOCKED j6a93 step=1 files=0 +0/-0 turns=3 cost=$0.001",
        'question: step needs package zod@^3 (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without.',
        "log: .cheapag/jobs/j6a93/",
      ),
    );
  });

  test("CONFLICT", () => {
    expect(
      renderJob(
        job({
          job: "j3d55",
          status: "CONFLICT",
          steps: "3",
          tests: "pass",
          usage: { turns: 11, costUsd: 0.009 },
          redo: 1,
          changed: [ch("M", "src/api/login.ts", 14, 4), ch("A", "test/limit.test.ts", 6)],
          worktree: ".cheapag/worktrees/j3d55",
          conflict: [
            "src/api/login.ts (also changed by j3d54, landed first; redo could not reconcile)",
          ],
        }),
      ),
    ).toBe(
      block(
        "CONFLICT j3d55 step=3 files=2 +20/-4 tests=pass turns=11 cost=$0.009 redo=1",
        "changed:",
        "  M src/api/login.ts +14 -4",
        "  A test/limit.test.ts +6",
        "conflict:",
        "  src/api/login.ts (also changed by j3d54, landed first; redo could not reconcile)",
        "worktree: .cheapag/worktrees/j3d55/",
        "log: .cheapag/jobs/j3d55/",
      ),
    );
  });

  test("BUDGET", () => {
    expect(
      renderJob(
        job({
          job: "j9q2w",
          status: "BUDGET",
          steps: "4",
          usage: { turns: 18, costUsd: 0.006 },
          changed: [ch("A", "src/a.ts", 30), ch("A", "src/b.ts", 10)],
          worktree: ".cheapag/worktrees/j9q2w",
          reason:
            "Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus, glm-5.3 (resets ~16:40)",
        }),
      ),
    ).toBe(
      block(
        "BUDGET j9q2w step=4 files=2 +40/-0 turns=18 cost=$0.006",
        "changed:",
        "  A src/a.ts +30",
        "  A src/b.ts +10",
        "reason: Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus, glm-5.3 (resets ~16:40)",
        "worktree: .cheapag/worktrees/j9q2w/",
        "log: .cheapag/jobs/j9q2w/",
      ),
    );
  });

  test("PROVIDER: reason, then the next: line asking the user", () => {
    const text = renderJob(
      job({
        job: "jp1x2",
        status: "PROVIDER",
        steps: "1",
        reason: "deepseek-v4.1-flash is failing (last error: overloaded); other models: none",
      }),
    );
    expect(text).toContain(
      "reason: deepseek-v4.1-flash is failing (last error: overloaded); other models: none\nnext: ask the user: continue with Claude, or switch the worker to another model (delegate again with model: <id>)",
    );
  });

  test("TIMEOUT: reason, missing, worktree", () => {
    expect(
      renderJob(
        job({
          job: "j1t0a",
          status: "TIMEOUT",
          steps: "6",
          tests: "none",
          usage: { turns: 31, costUsd: 0.012 },
          summary: "half the handlers migrated",
          missing: ["src/api/admin.ts"],
          reason: "20-minute job cap hit",
          worktree: ".cheapag/worktrees/j1t0a",
        }),
      ),
    ).toBe(
      block(
        "TIMEOUT j1t0a step=6 files=0 +0/-0 tests=none turns=31 cost=$0.012",
        "summary: half the handlers migrated",
        "reason: 20-minute job cap hit",
        "missing:",
        "  - src/api/admin.ts",
        "worktree: .cheapag/worktrees/j1t0a/",
        "log: .cheapag/jobs/j1t0a/",
      ),
    );
  });

  test("CANCELLED", () => {
    expect(
      renderJob(
        job({
          job: "j0c1d",
          status: "CANCELLED",
          usage: { turns: 4, costUsd: 0.002 },
          reason: "server restarted while the job was running",
          worktree: ".cheapag/worktrees/j0c1d",
        }),
      ),
    ).toBe(
      block(
        "CANCELLED j0c1d step=1 files=0 +0/-0 turns=4 cost=$0.002",
        "reason: server restarted while the job was running",
        "worktree: .cheapag/worktrees/j0c1d/",
        "log: .cheapag/jobs/j0c1d/",
      ),
    );
  });

  test("RUNNING is one line", () => {
    expect(
      renderJob(
        job({
          job: "j6a91",
          status: "RUNNING",
          summary: "ignored",
          usage: { turns: 14, costUsd: 0.003 },
        }),
      ),
    ).toBe("RUNNING j6a91 step=1 turns=14");
  });

  test("CONSENT", () => {
    expect(
      renderConsent({
        repo: "cheapAg",
        send: "code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
        retention: "deepseek-*, qwen-* = zero retention; glm-5.3, kimi-k3 = not stated",
        approve: "ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only",
      }),
    ).toBe(
      block(
        "CONSENT repo=cheapAg",
        "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
        "retention: deepseek-*, qwen-* = zero retention; glm-5.3, kimi-k3 = not stated",
        "approve: ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only",
      ),
    );
  });
});

describe("optional headline tokens", () => {
  const base = {
    job: "j1",
    status: "OK" as const,
    tests: "pass" as const,
    usage: { turns: 1, costUsd: 0.0004 },
  };
  test.each([
    ["none", {}, ""],
    ["fix", { selfFix: 1 }, " fix=1"],
    [
      "esc + model",
      { selfFix: 2, models: { requested: FLASH, final: "x/pro", escalated: true } },
      " fix=2 esc=1 model=x/pro",
    ],
    [
      "model alone (fallback)",
      { models: { requested: FLASH, final: "x/qwen", escalated: false } },
      " model=x/qwen",
    ],
    ["redo", { redo: 1 }, " redo=1"],
    ["billing", { billing: "zen" as const }, " billing=zen"],
    [
      "all, in D3 order",
      {
        selfFix: 1,
        models: { requested: FLASH, final: "x/pro", escalated: true },
        redo: 1,
        billing: "zen" as const,
      },
      " fix=1 esc=1 model=x/pro redo=1 billing=zen",
    ],
  ])("%s", (_, extra, tokens) => {
    expect(renderJob(job({ ...base, ...extra })).split("\n")[0]).toBe(
      `OK j1 step=1 files=0 +0/-0 tests=pass turns=1 cost=$0.000${tokens}`,
    );
  });
});

describe("D7 research block", () => {
  const answer = [
    "JWT is validated in src/middleware/auth.ts:18-42 (verifyToken), called for all /api/* routes",
    "from src/app.ts:31. Expired tokens throw TokenExpiredError, mapped to 401 in",
    "src/middleware/errors.ts:12. Refresh is client-side only; no server refresh endpoint.",
  ];
  test("ANSWER with refs, confidence and the unlanded-jobs note", () => {
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r5k2q",
        status: "ANSWER",
        filesRead: 9,
        usage: { turns: 11, costUsd: 0.003 },
        answer: answer.join("\n"),
        confidence: "high",
        unlanded: ["j6a91", "j6a92"],
        refs: [
          { path: "src/middleware/auth.ts", start: 18, end: 42 },
          { path: "src/app.ts", start: 31, end: 31 },
          { path: "src/middleware/errors.ts", start: 12, end: 12 },
        ],
      }),
    ).toBe(
      block(
        "ANSWER r5k2q files_read=9 turns=11 cost=$0.003",
        "files: src/middleware/auth.ts:18-42, src/app.ts:31, src/middleware/errors.ts:12",
        "notes:",
        ...answer,
        "confidence: high",
        "note: 2 jobs not yet landed (j6a91, j6a92); their changes are not visible to research",
        "log: .cheapag/jobs/r5k2q/",
      ),
    );
  });
  test("UNSURE on a fallback model, no note when everything landed", () => {
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r1",
        status: "UNSURE",
        filesRead: 3,
        usage: { turns: 4, costUsd: 0.001 },
        models: { requested: "a/flash", final: "a/flash2" },
        answer: "No refresh endpoint found.",
        refs: [],
        confidence: "low",
        unlanded: [],
      }),
    ).toBe(
      block(
        "UNSURE r1 files_read=3 turns=4 cost=$0.001 model=a/flash2",
        "notes:",
        "No refresh endpoint found.",
        "confidence: low",
        "log: .cheapag/jobs/r1/",
      ),
    );
  });
  test("a scout brief with a reproduction and dead ends (ticket 23.4)", () => {
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r3",
        status: "ANSWER",
        filesRead: 2,
        usage: { turns: 5, costUsd: 0.002 },
        answer: "Expiry is checked after decoding.",
        refs: [{ path: "src/auth.ts", start: 18, end: 42 }],
        repro: "`pytest tests/test_auth.py -k expiry` → 1 failed",
        deadEnds: "middleware order is fine",
        confidence: "high",
        unlanded: [],
      }),
    ).toBe(
      block(
        "ANSWER r3 files_read=2 turns=5 cost=$0.002",
        "files: src/auth.ts:18-42",
        "repro: `pytest tests/test_auth.py -k expiry` → 1 failed",
        "dead ends: middleware order is fine",
        "notes:",
        "Expiry is checked after decoding.",
        "confidence: high",
        "log: .cheapag/jobs/r3/",
      ),
    );
  });
  test("FAIL with a reason", () => {
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r2",
        status: "FAIL",
        filesRead: 0,
        usage: { turns: 0, costUsd: 0 },
        answer: "",
        refs: [],
        reason: "worker error: upstream 500",
        unlanded: ["j1"],
      }),
    ).toBe(
      block(
        "FAIL r2 files_read=0 turns=0 cost=$0.000",
        "reason: worker error: upstream 500",
        "note: 1 job not yet landed (j1); their changes are not visible to research",
        "log: .cheapag/jobs/r2/",
      ),
    );
  });
});

describe("D6 batch blocks", () => {
  const batch = (b: Partial<BatchRecord>): BatchRecord => ({
    format: "cheapag/1",
    batch: "b4k1x",
    groups: ["1", "2", "3"],
    notes: [],
    integration: "pending",
    jobs: [],
    ...b,
  });
  const blocked = job({
    job: "j6a90",
    status: "BLOCKED",
    steps: "2",
    usage: { turns: 9, costUsd: 0.004 },
    question: { text: "Rate limit should:", options: ["run before lockout", "run after lockout"] },
  });

  test("early return: BLOCKED first, RUNNING as adjacent single lines, next:", () => {
    const running = [
      job({ job: "j6a91", status: "RUNNING", steps: "1", usage: { turns: 14, costUsd: 0.003 } }),
      job({ job: "j6a92", status: "RUNNING", steps: "3", usage: { turns: 3, costUsd: 0.002 } }),
    ];
    expect(renderBatch(batch({}), [running[0], blocked, running[1]])).toBe(
      block(
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
      ),
    );
  });

  test("completed: note, OK headlines only (no summary/changed/review/log), full-blocks line, no next:", () => {
    const ok = (
      id: string,
      steps: string,
      summary: string,
      cost: number,
      review: JobRecord["review"] = [],
    ) =>
      job({
        job: id,
        status: "OK",
        landed: true,
        steps,
        tests: "pass",
        summary,
        review,
        usage: { turns: 5, costUsd: cost },
      });
    expect(
      renderBatch(
        batch({ integration: "pass", notes: ["steps 2,3 serialized (src/api/login.ts)"] }),
        [
          ok("j6a90", "2", "limiter runs before lockout on POST /api/login", 0.01, [
            { path: "src/api/login.ts", start: 12, end: 30 },
          ]),
          ok("j6a91", "1", "sliding-window redis limiter with tests", 0.013),
          ok("j6a92", "3", "documented 429 + Retry-After under /api/login", 0.004),
        ],
      ),
    ).toBe(
      block(
        "BATCH b4k1x groups=3 OK=3 landed=3 integration=pass cost=$0.027",
        "note: steps 2,3 serialized (src/api/login.ts)",
        "OK j6a90 step=2 files=0 +0/-0 tests=pass turns=5 cost=$0.010",
        "",
        "OK j6a91 step=1 files=0 +0/-0 tests=pass turns=5 cost=$0.013",
        "",
        "OK j6a92 step=3 files=0 +0/-0 tests=pass turns=5 cost=$0.004",
        "full blocks: jobs show j6a90, j6a91, j6a92",
      ),
    );
  });

  test("one OK (with risks) and one FAIL: action sections only, then full blocks; jobs show of the OK keeps its summary", () => {
    const okJob = job({
      job: "j1",
      status: "OK",
      landed: true,
      steps: "1",
      summary: "wrote it",
      risks: ["touches the cache key"],
      review: [{ path: "a.ts", start: 1, end: 2 }],
      changed: [ch("M", "a.ts", 1)],
    });
    const failJob = job({
      job: "j2",
      status: "FAIL",
      steps: "2",
      summary: "should not show",
      error: ["`npm test`", "  ✗ boom"],
      found: "got partway",
      tried: ["fix 1: x"],
      reason: "gave up",
      worktree: ".cheapag/worktrees/j2",
      changed: [ch("M", "b.ts", 1)],
    });
    expect(renderBatch(batch({ groups: ["1", "2"] }), [okJob, failJob])).toBe(
      block(
        "BATCH b4k1x groups=2 FAIL=1 OK=1 landed=1 integration=pending cost=$0.000",
        "FAIL j2 step=2 files=1 +1/-0 turns=0 cost=$0.000",
        "error: `npm test`",
        "  ✗ boom",
        "found: got partway",
        "tried:",
        "  - fix 1: x",
        "reason: gave up",
        "worktree: .cheapag/worktrees/j2/",
        "",
        "OK j1 step=1 files=1 +1/-0 turns=0 cost=$0.000",
        "risks:",
        "  - touches the cache key",
        "full blocks: jobs show j2, j1",
      ),
    );
    expect(renderJob(okJob)).toContain("summary: wrote it");
  });

  test("wait=false: RUNNING only", () => {
    expect(
      renderBatch(batch({ batch: "b7m2p", groups: ["4", "5"] }), [
        job({ job: "j7m20", status: "RUNNING", steps: "4" }),
        job({ job: "j7m21", status: "RUNNING", steps: "5" }),
      ]),
    ).toBe(
      block(
        "BATCH b7m2p groups=2 RUNNING=2 landed=0 integration=pending cost=$0.000",
        "RUNNING j7m20 step=4 turns=0",
        "RUNNING j7m21 step=5 turns=0",
        'next: jobs(action="wait", job="b7m2p")',
      ),
    );
  });

  test("urgency order and counts; integration failure shows its error: after the header", () => {
    const s = (id: string, status: JobRecord["status"]) =>
      job({ job: id, status, landed: status === "OK", usage: { turns: 1, costUsd: 0.001 } });
    const text = renderBatch(
      batch({
        integration: "fail",
        groups: ["1", "2", "3", "4", "5", "6", "7"],
        integrationError: ["`npm test`", "  ✗ suite broke"],
      }),
      [
        s("j1", "OK"),
        s("j2", "PARTIAL"),
        s("j3", "TIMEOUT"),
        s("j4", "FAIL"),
        s("j5", "CONFLICT"),
        s("j6", "BUDGET"),
        s("j7", "CANCELLED"),
      ],
    );
    const lines = text.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "BATCH b4k1x groups=7 CONFLICT=1 FAIL=1 BUDGET=1 TIMEOUT=1 CANCELLED=1 PARTIAL=1 OK=1 landed=1 integration=fail cost=$0.007",
      "error: `npm test`",
      "  ✗ suite broke",
    ]);
    // BUDGET, TIMEOUT and CANCELLED share a rank and keep their input order
    expect(lines.filter((l) => /^[A-Z]+ j\d /.test(l)).map((l) => l.split(" ")[1])).toEqual([
      "j5",
      "j4",
      "j3",
      "j6",
      "j7",
      "j2",
      "j1",
    ]);
    expect(text).not.toContain("next:");
  });

  test("a failing integration check: error: after the header, then the fix job's block, then the groups; its cost counts", () => {
    const ok = (id: string, steps: string) =>
      job({
        job: id,
        status: "OK",
        landed: true,
        steps,
        tests: "none",
        usage: { turns: 2, costUsd: 0.001 },
      });
    const fix = job({
      job: "j9f00",
      status: "FAIL",
      steps: "1,2",
      tests: "fail",
      usage: { turns: 6, costUsd: 0.002 },
      worktree: ".cheapag/worktrees/j9f00",
      error: ["`npm test`", "  ✗ login uses renamed helper"],
      tried: ["fix 1: renamed call → same failure"],
    });
    expect(
      renderBatch(
        batch({
          groups: ["1", "2"],
          integration: "fail",
          integrationError: ["`npm test`", "  ✗ login uses renamed helper"],
          fix: "j9f00",
        }),
        [ok("j1", "1"), ok("j2", "2")],
        fix,
      ),
    ).toBe(
      block(
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
        "",
        "OK j2 step=2 files=0 +0/-0 tests=none turns=2 cost=$0.001",
        "full blocks: jobs show j1, j2",
      ),
    );
  });

  test("integration states: running while the check or fix job runs (the fix job as one RUNNING line), none without a command", () => {
    const ok = job({ job: "j1", status: "OK", landed: true, steps: "1" });
    expect(
      renderBatch(
        batch({ groups: ["1"], integration: "running", fix: "j9f00" }),
        [ok],
        job({ job: "j9f00", status: "RUNNING", steps: "1", usage: { turns: 3, costUsd: 0 } }),
      ),
    ).toBe(
      block(
        "BATCH b4k1x groups=1 OK=1 landed=1 integration=running cost=$0.000",
        "RUNNING j9f00 step=1 turns=3",
        "",
        "OK j1 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "full blocks: jobs show j1",
        'next: jobs(action="wait", job="b4k1x")',
      ),
    );
    expect(renderBatch(batch({ groups: ["1"], integration: "none" }), [ok]).split("\n")[0]).toBe(
      "BATCH b4k1x groups=1 OK=1 landed=1 integration=none cost=$0.000",
    );
  });
});

describe("D9 budget and truncation", () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      ch("M", `src/module${String(i).padStart(2, "0")}/index.ts`, 1),
    );
  const long = (tag: string, n: number) => `${tag} ${"x".repeat(n - tag.length - 1)}`;

  test("a block within budget is untouched (changed capped at 15)", () => {
    const text = renderJob(
      job({ job: "j1", status: "OK", landed: true, summary: "s", changed: files(16) }),
      1000,
    );
    expect(text).toContain("\n  M src/module14/index.ts +1\n  … +1 more\nlog:");
  });

  test("cuts only as far as needed: changed → 5 is enough here", () => {
    const r = job({
      job: "j1",
      status: "OK",
      landed: true,
      summary: "s",
      changed: files(15),
      risks: ["a", "b", "c", "d"],
    });
    const text = renderJob(r, 110);
    expect(text.length / 4).toBeLessThanOrEqual(110);
    expect(renderJob(r).length / 4).toBeGreaterThan(110); // uncut at the default 400
    expect(text).toBe(
      block(
        "OK j1 step=1 files=15 +15/-0 turns=0 cost=$0.000",
        "summary: s",
        "changed:",
        ...files(5).map((c) => `  M ${c.path} +1`),
        "  … +10 more",
        "risks:",
        "  - a",
        "  - b",
        "  - c",
        "  - d",
        "log: .cheapag/jobs/j1/",
      ),
    );
  });

  test("full order on a FAIL: changed → 5, tried → last, risks → 3, review → 3, error → 12-line floor, summary → 100; never-cut sections stay", () => {
    const error = [
      "`npm test`",
      ...Array.from({ length: 24 }, (_, i) => `  ${long(`✗ failure ${i}`, 150)}`),
    ];
    const text = renderJob(
      job({
        job: "j9",
        status: "FAIL",
        tests: "fail",
        summary: long("summary", 160),
        changed: files(20),
        risks: [1, 2, 3, 4, 5].map((i) => long(`risk ${i}`, 120)),
        review: [1, 2, 3, 4, 5].map((i) => ({
          path: `src/module0${i}/index.ts`,
          start: 1,
          end: 9,
        })),
        tried: ["fix 1: a → same failure", "fix 2: b → same failure", "esc: c → same failure"],
        error,
        reason: "worker error: upstream 500",
        worktree: ".cheapag/worktrees/j9",
      }),
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe(`summary: ${long("summary", 160).slice(0, 99)}…`);
    expect(text).toContain("\n  … +15 more\nrisks:\n");
    expect(lines.filter((l) => l.startsWith("  - risk"))).toHaveLength(3);
    expect(text).toContain(
      "\nreview: src/module01/index.ts:1-9, src/module02/index.ts:1-9, src/module03/index.ts:1-9\nerror:",
    );
    const errorLines = lines.slice(
      lines.findIndex((l) => l.startsWith("error:")),
      lines.indexOf("tried:"),
    );
    expect(errorLines).toHaveLength(12);
    expect(errorLines.at(-1)).toBe("  … +14 more lines (see log)");
    expect(
      text.endsWith(
        block(
          "tried:",
          "  - esc: c → same failure",
          "reason: worker error: upstream 500",
          "worktree: .cheapag/worktrees/j9/",
          "log: .cheapag/jobs/j9/",
        ),
      ),
    ).toBe(true);
  });

  test("error is cut only as far as the budget needs, never below 12 lines", () => {
    const error = [
      "`npm test`",
      ...Array.from({ length: 24 }, (_, i) => `  ✗ failure ${i} ${"y".repeat(40)}`),
    ];
    const text = renderJob(
      job({ job: "j8", status: "FAIL", tests: "fail", summary: "s", error }),
      250,
    );
    const lines = text.split("\n");
    const errorLines = lines.slice(
      lines.findIndex((l) => l.startsWith("error:")),
      lines.indexOf("log: .cheapag/jobs/j8/"),
    );
    expect(text.length / 4).toBeLessThanOrEqual(250);
    expect(errorLines.length).toBeGreaterThan(12);
    expect(errorLines.length).toBeLessThan(25);
  });

  test("golden: several questions, numbered, each with its own lettered options, within the default budget", () => {
    const text = renderJob(
      job({
        job: "j6a90",
        status: "BLOCKED",
        steps: "2",
        usage: { turns: 4, costUsd: 0.002 },
        question: null,
        questions: [
          {
            text: "login already has a per-user lockout in src/auth/lockout.ts. Rate limit should:",
            options: [
              "run before lockout (counts all attempts)",
              "run after lockout (counts only non-locked users)",
              "replace lockout entirely",
            ],
          },
          {
            text: "Where should the counters live?",
            options: ["in memory (per process)", "redis (shared across instances)"],
          },
          { text: "Name the config key for the limit", options: [] },
        ],
      }),
    );
    expect(text).toBe(
      block(
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
      ),
    );
    expect(text.length / 4).toBeLessThanOrEqual(250);
  });

  test("never cut: several long questions and all their options survive an over-budget block", () => {
    const qs = [1, 2].map((n) => ({
      text: long(`question${n}`, 300),
      options: ["a", "b", "c", "d"].map((x) => long(`option ${n}${x}`, 150)),
    }));
    const text = renderJob(
      job({
        job: "j7",
        status: "BLOCKED",
        risks: ["r".repeat(100)],
        question: null,
        questions: qs,
      }),
    );
    for (const [i, q] of qs.entries()) {
      expect(text).toContain(`\nquestion ${i + 1}: ${q.text}\n`);
      for (const o of q.options) expect(text).toContain(`) ${o}\n`);
    }
  });

  test("never cut: a long question and all options survive an over-budget block", () => {
    const options = ["a", "b", "c", "d"].map((x) => long(`option ${x}`, 300));
    const text = renderJob(
      job({ job: "j7", status: "BLOCKED", question: { text: long("question", 400), options } }),
    );
    expect(text).toContain(`\nquestion: ${long("question", 400)}\n`);
    for (const o of options) expect(text).toContain(`) ${o}\n`);
  });
});

describe("D9 line rules", () => {
  test("lines over 200 chars are middle-elided; tabs become 2 spaces; multi-line fields become one line", () => {
    const text = renderJob(
      job({
        job: "j1",
        status: "FAIL",
        summary: "first\n  second",
        reason: `start ${"r".repeat(300)} end`,
        error: ["`cmd`", "\tindented by a tab"],
        risks: ["one\ntwo"],
      }),
    );
    const reason = text.split("\n").find((l) => l.startsWith("reason:"))!;
    expect(reason).toHaveLength(200);
    expect(reason).toMatch(/^reason: start r+…r+ end$/);
    expect(text).toContain("\nsummary: first second\n");
    expect(text).toContain("\n  - one two\n");
    expect(text).toContain("\n  indented by a tab\n");
    expect(text).not.toContain("\t");
  });
});

// Pins exact blocks for the paths the goldens above leave open, so a refactor of src/report.ts cannot move a byte.
describe("pinned blocks", () => {
  const batch = (b: Partial<BatchRecord>): BatchRecord => ({
    format: "cheapag/1",
    batch: "b4k1x",
    groups: ["1"],
    notes: [],
    integration: "pending",
    jobs: [],
    ...b,
  });
  const NEXT_PERMISSION =
    "next: ask the user with AskUserQuestion, then reply(job, letter). Never pick for them.";
  const ALWAYS_SED = "b) always allow `sed` in this repo (adds it to cheapag.json allow_commands)";

  test("failBlock, permissionOptions and NO_SUMMARY", () => {
    expect(failBlock("bad input")).toBe("FAIL reason: bad input");
    expect(permissionOptions("npm run")).toEqual([
      "allow once",
      "always allow `npm run` in this repo (adds it to cheapag.json allow_commands)",
      "refuse",
    ]);
    expect(NO_SUMMARY).toBe("(worker gave no summary)");
  });

  test("a permission block: one-line fields, b) unless always is false, same text compacted or over budget", () => {
    const blocked = (extra: Partial<PermissionBlock> = {}) =>
      job({
        job: "jp1",
        status: "BLOCKED",
        steps: "2",
        usage: { turns: 3, costUsd: 0.001 },
        summary: "ignored",
        changed: [ch("M", "a.ts", 1)],
        question: { text: "ignored", options: ["x"] },
        permission: {
          title: " Peek\n at f ",
          command: "sed -n 1,2p f",
          why: "need\tto see it",
          prefix: "sed",
          ...extra,
        },
      });
    const head = [
      "BLOCKED jp1 step=2 permission",
      "title: Peek at f",
      "command: sed -n 1,2p f",
      "why: need  to see it",
      "a) allow once",
    ];
    const withAlways = block(...head, ALWAYS_SED, "c) refuse", NEXT_PERMISSION);
    expect(renderJob(blocked())).toBe(withAlways);
    expect(renderJob(blocked({ always: true }))).toBe(withAlways);
    expect(renderJob(blocked(), 1, true)).toBe(withAlways);
    expect(renderJob(blocked({ always: false }))).toBe(
      block(...head, "c) refuse", NEXT_PERMISSION),
    );
    const long = renderJob(blocked({ command: "x".repeat(300) })).split("\n")[2];
    expect(long).toBe(`command: ${"x".repeat(91)}…${"x".repeat(99)}`);
    const ok = job({ job: "j1", status: "OK", permission: blocked().permission });
    expect(renderJob(ok)).toBe(
      block("OK j1 step=1 files=0 +0/-0 turns=0 cost=$0.000", "log: .cheapag/jobs/j1/"),
    );
  });

  test("headline: repro= and test= come last; any redo shows redo=1; check= without tests=", () => {
    const headline = (extra: Partial<JobRecord>) =>
      renderJob(job({ job: "j1", status: "OK", ...extra })).split("\n")[0];
    expect(
      headline({
        tests: "pass",
        usage: { turns: 1, costUsd: 0.0004 },
        selfFix: 1,
        models: { requested: FLASH, final: "x/pro", escalated: true },
        redo: 2,
        billing: "zen",
        repro: "fail→pass",
        test: "test/a.test.ts",
      }),
    ).toBe(
      "OK j1 step=1 files=0 +0/-0 tests=pass turns=1 cost=$0.000 fix=1 esc=1 model=x/pro redo=1 billing=zen repro=fail→pass test=test/a.test.ts",
    );
    expect(headline({ redo: null })).toBe("OK j1 step=1 files=0 +0/-0 turns=0 cost=$0.000");
    expect(headline({ redo: 0 })).toBe("OK j1 step=1 files=0 +0/-0 turns=0 cost=$0.000");
    expect(headline({ status: "FAIL", check: "env" })).toBe(
      "FAIL j1 step=1 files=0 +0/-0 check=env turns=0 cost=$0.000",
    );
  });

  test("OK with a cleanup error: counts only when non-zero, a risk clipped at 120, no worktree: line", () => {
    expect(
      renderJob(
        job({
          job: "j1c2d",
          status: "OK",
          landed: true,
          tests: "pass",
          usage: { turns: 4, costUsd: 0.002 },
          summary: "renamed\tthe helper",
          changed: [
            ch("D", "src/old.ts", 0, 12),
            ch("A", "src/empty.ts", 0),
            ch("R", "src/new.ts", 5, 1),
          ],
          risks: [`r${"k".repeat(129)}`],
          cleanupError: "EBUSY: resource busy\nor locked",
          worktree: ".cheapag/worktrees/j1c2d",
        }),
      ),
    ).toBe(
      block(
        "OK j1c2d step=1 files=3 +5/-13 tests=pass turns=4 cost=$0.002",
        "summary: renamed  the helper",
        "changed:",
        "  D src/old.ts -12",
        "  A src/empty.ts",
        "  R src/new.ts +5 -1",
        "risks:",
        `  - r${"k".repeat(118)}…`,
        "cleanup error: EBUSY: resource busy or locked (the change landed; only its worktree folder was left behind)",
        "log: .cheapag/jobs/j1c2d/",
      ),
    );
  });

  test("TIMEOUT with no summary: found: leads, before changed:", () => {
    expect(
      renderJob(
        job({
          job: "jt1",
          status: "TIMEOUT",
          steps: "3",
          usage: { turns: 30, costUsd: 0.01 },
          summary: NO_SUMMARY,
          found: "a.ts:12 loops forever",
          changed: [ch("M", "a.ts", 2, 1)],
          reason: "20-minute job cap hit",
          missing: ["the fix"],
          worktree: ".cheapag/worktrees/jt1",
        }),
      ),
    ).toBe(
      block(
        "TIMEOUT jt1 step=3 files=1 +2/-1 turns=30 cost=$0.010",
        "found: a.ts:12 loops forever",
        "changed:",
        "  M a.ts +2 -1",
        "reason: 20-minute job cap hit",
        "missing:",
        "  - the fix",
        "worktree: .cheapag/worktrees/jt1/",
        "log: .cheapag/jobs/jt1/",
      ),
    );
  });

  test("BUDGET with a summary and found:", () => {
    expect(
      renderJob(
        job({
          job: "jb1",
          status: "BUDGET",
          usage: { turns: 2, costUsd: 0.001 },
          summary: "half done",
          found: "b.ts:3 is the culprit",
          reason: "Go 5h window exhausted (resets ~16:40)",
          worktree: ".cheapag/worktrees/jb1",
        }),
      ),
    ).toBe(
      block(
        "BUDGET jb1 step=1 files=0 +0/-0 turns=2 cost=$0.001",
        "summary: half done",
        "found: b.ts:3 is the culprit",
        "reason: Go 5h window exhausted (resets ~16:40)",
        "worktree: .cheapag/worktrees/jb1/",
        "log: .cheapag/jobs/jb1/",
      ),
    );
  });

  test("PROVIDER: found leads, next: sits between reason: and worktree:, missing is not its section", () => {
    expect(
      renderJob(
        job({
          job: "jp2",
          status: "PROVIDER",
          usage: { turns: 1, costUsd: 0 },
          summary: NO_SUMMARY,
          found: "c.ts:9",
          reason: "x is failing",
          missing: ["ignored"],
          worktree: ".cheapag/worktrees/jp2",
        }),
      ),
    ).toBe(
      block(
        "PROVIDER jp2 step=1 files=0 +0/-0 turns=1 cost=$0.000",
        "found: c.ts:9",
        "reason: x is failing",
        "next: ask the user: continue with Claude, or switch the worker to another model (delegate again with model: <id>)",
        "worktree: .cheapag/worktrees/jp2/",
        "log: .cheapag/jobs/jp2/",
      ),
    );
  });

  test("CANCELLED has no found section: the no-summary line stays and found: is dropped", () => {
    expect(
      renderJob(
        job({
          job: "jc1",
          status: "CANCELLED",
          summary: NO_SUMMARY,
          found: "d.ts",
          reason: "stopped",
        }),
      ),
    ).toBe(
      block(
        "CANCELLED jc1 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "summary: (worker gave no summary)",
        "reason: stopped",
        "log: .cheapag/jobs/jc1/",
      ),
    );
  });

  test("questions: at most 4 options, tabs become 2 spaces, an empty questions list hides question, only BLOCKED shows it", () => {
    expect(
      renderJob(
        job({
          job: "jq1",
          status: "BLOCKED",
          question: { text: "pick\tone", options: ["1", "2", "3", "4", "5"] },
        }),
      ),
    ).toBe(
      block(
        "BLOCKED jq1 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "question: pick  one",
        "options:",
        "  a) 1",
        "  b) 2",
        "  c) 3",
        "  d) 4",
        "log: .cheapag/jobs/jq1/",
      ),
    );
    expect(
      renderJob(
        job({
          job: "jq2",
          status: "BLOCKED",
          question: { text: "hidden", options: [] },
          questions: [],
        }),
      ),
    ).toBe(
      block("BLOCKED jq2 step=1 files=0 +0/-0 turns=0 cost=$0.000", "log: .cheapag/jobs/jq2/"),
    );
    expect(
      renderJob(job({ job: "jq3", status: "FAIL", question: { text: "hidden", options: ["x"] } })),
    ).toBe(block("FAIL jq3 step=1 files=0 +0/-0 turns=0 cost=$0.000", "log: .cheapag/jobs/jq3/"));
  });

  test("a found: note that is one word over 200 chars: the label stands alone, the word is middle-elided", () => {
    expect(renderJob(job({ job: "jf1", status: "PARTIAL", found: "f".repeat(300) }))).toBe(
      block(
        "PARTIAL jf1 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "found:",
        `${"f".repeat(100)}…${"f".repeat(99)}`,
        "log: .cheapag/jobs/jf1/",
      ),
    );
  });

  test("an env error cut to the 12-line floor keeps the environment line first and the count last", () => {
    const error = [
      "exit 127: not found",
      ...Array.from({ length: 24 }, (_, i) => `  line ${i} ${"z".repeat(150)}`),
    ];
    expect(renderJob(job({ job: "je1", status: "FAIL", check: "env", error }), 100)).toBe(
      block(
        "FAIL je1 step=1 files=0 +0/-0 check=env turns=0 cost=$0.000",
        "error: environment: the check could not run (exit 127: not found)",
        ...error.slice(1, 11),
        "  … +14 more lines (see log)",
        "log: .cheapag/jobs/je1/",
      ),
    );
  });

  test("research: every section in order, status=partial, one-line repro and dead ends, notes word-wrapped", () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r9",
        status: "ANSWER",
        partial: true,
        filesRead: 4,
        usage: { turns: 6, costUsd: 0.002 },
        models: { requested: "a/flash", final: "a/flash" },
        answer: `  first line\n\n    indented\tline  \n${words.join(" ")}\n`,
        refs: [
          { path: "a.ts", start: 3, end: 3 },
          { path: "b.ts", start: 1, end: 9 },
        ],
        repro: "`npm test`\n→ 1 failed",
        deadEnds: "not the cache\nnot the router",
        confidence: "medium",
        reason: "turn cap",
        cleanupError: "EBUSY\nlocked",
        worktree: ".cheapag/worktrees/r9",
        unlanded: ["j1", "j2", "j3"],
      }),
    ).toBe(
      block(
        "ANSWER r9 files_read=4 turns=6 cost=$0.002 status=partial",
        "files: a.ts:3, b.ts:1-9",
        "repro: `npm test` → 1 failed",
        "dead ends: not the cache not the router",
        "notes:",
        "first line",
        "",
        "indented  line",
        words.slice(0, 50).join(" "),
        words.slice(50).join(" "),
        "confidence: medium",
        "reason: turn cap",
        "cleanup error: EBUSY locked",
        "worktree: .cheapag/worktrees/r9/",
        "note: 3 jobs not yet landed (j1, j2, j3); their changes are not visible to research",
        "log: .cheapag/jobs/r9/",
      ),
    );
    expect(
      renderResearch({
        format: "cheapag/1",
        job: "r8",
        status: "UNSURE",
        filesRead: 0,
        usage: { turns: 1, costUsd: 0 },
        answer: "  \n ",
        refs: [],
        unlanded: [],
      }),
    ).toBe(block("UNSURE r8 files_read=0 turns=1 cost=$0.000", "log: .cheapag/jobs/r8/"));
  });

  test("batch: compacted PARTIAL/FAIL/OK blocks, full CONFLICT/TIMEOUT/BLOCKED blocks, notes joined, reply then wait", () => {
    const jobs = [
      job({
        job: "j1",
        status: "OK",
        landed: true,
        summary: "done",
        changed: [ch("M", "a.ts", 1)],
        cleanupError: "EBUSY",
      }),
      job({
        job: "j2",
        status: "PARTIAL",
        summary: "half",
        found: "b.ts:4",
        missing: ["the rest"],
        changed: [ch("M", "b.ts", 2)],
        worktree: ".cheapag/worktrees/j2",
      }),
      job({
        job: "j3",
        status: "FAIL",
        summary: NO_SUMMARY,
        error: ["`npm test`"],
        found: "c.ts:1",
        reason: "turn cap",
        worktree: ".cheapag/worktrees/j3",
      }),
      job({
        job: "j4",
        status: "TIMEOUT",
        summary: "slow",
        reason: "cap hit",
        worktree: ".cheapag/worktrees/j4",
      }),
      job({
        job: "j5",
        status: "CONFLICT",
        conflict: ["a.ts (also changed by j1)"],
        worktree: ".cheapag/worktrees/j5",
      }),
      job({
        job: "j6",
        status: "BLOCKED",
        question: { text: "which one?", options: ["this", "that"] },
      }),
    ];
    const groups = ["1", "2", "3", "4", "5", "6"];
    expect(renderBatch(batch({ batch: "b1", groups, notes: ["note one", "note two"] }), jobs)).toBe(
      block(
        "BATCH b1 groups=6 BLOCKED=1 CONFLICT=1 FAIL=1 TIMEOUT=1 PARTIAL=1 OK=1 landed=1 integration=pending cost=$0.000",
        "note: note one; note two",
        "BLOCKED j6 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "question: which one?",
        "options:",
        "  a) this",
        "  b) that",
        "log: .cheapag/jobs/j6/",
        "",
        "CONFLICT j5 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "conflict:",
        "  a.ts (also changed by j1)",
        "worktree: .cheapag/worktrees/j5/",
        "log: .cheapag/jobs/j5/",
        "",
        "FAIL j3 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "error: `npm test`",
        "found: c.ts:1",
        "reason: turn cap",
        "worktree: .cheapag/worktrees/j3/",
        "",
        "TIMEOUT j4 step=1 files=0 +0/-0 turns=0 cost=$0.000",
        "summary: slow",
        "reason: cap hit",
        "worktree: .cheapag/worktrees/j4/",
        "log: .cheapag/jobs/j4/",
        "",
        "PARTIAL j2 step=1 files=1 +2/-0 turns=0 cost=$0.000",
        "found: b.ts:4",
        "missing:",
        "  - the rest",
        "worktree: .cheapag/worktrees/j2/",
        "",
        "OK j1 step=1 files=1 +1/-0 turns=0 cost=$0.000",
        "cleanup error: EBUSY (the change landed; only its worktree folder was left behind)",
        "full blocks: jobs show j3, j2, j1",
        'next: reply(job="j6", ...) then jobs(action="wait", job="b1")',
      ),
    );
  });

  test("batch: a RUNNING fix job and a RUNNING group job are separate chunks; no jobs gives the header alone", () => {
    expect(
      renderBatch(
        batch({ integration: "running", fix: "j9" }),
        [job({ job: "j1", status: "RUNNING", usage: { turns: 2, costUsd: 0.001 } })],
        job({ job: "j9", status: "RUNNING", usage: { turns: 1, costUsd: 0.002 } }),
      ),
    ).toBe(
      block(
        "BATCH b4k1x groups=1 RUNNING=1 landed=0 integration=running cost=$0.003",
        "RUNNING j9 step=1 turns=1",
        "",
        "RUNNING j1 step=1 turns=2",
        'next: jobs(action="wait", job="b4k1x")',
      ),
    );
    expect(renderBatch(batch({ groups: [] }), [])).toBe(
      "BATCH b4k1x groups=0 landed=0 integration=pending cost=$0.000",
    );
  });

  test("header and consent lines over 200 chars are middle-elided", () => {
    const head = renderBatch(batch({ notes: ["n".repeat(300)] }), []).split("\n")[1];
    expect(head).toBe(`note: ${"n".repeat(94)}…${"n".repeat(99)}`);
    const consent = renderConsent({
      repo: "r",
      send: "s".repeat(300),
      retention: "x",
      approve: "y",
    });
    expect(consent).toBe(
      block(
        "CONSENT repo=r",
        `send: ${"s".repeat(94)}…${"s".repeat(99)}`,
        "retention: x",
        "approve: y",
      ),
    );
  });
});
