import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, startServer, tempRepo } from "./harness.js";

type StepSpec = { id: string; files: string; needs?: string };
const plan = (steps: StepSpec[]) =>
  `# Batch\n\n${steps.map((s) => `## ${s.id} step ${s.id}\nfiles: ${s.files}\ndone-when: done\n${s.needs ? `needs: ${s.needs}\n` : ""}`).join("\n")}`;
const finish = (summary: string): Action => ({ finish: { summary, risks: [], review: [], missing: [] } });
/** The worker writes `file` and finishes. */
const writes = (file: string, ...extra: Action[]): Action[] => [...extra, { edit: file, content: `${file}\n` }, { tool: "write" }, finish(`wrote ${file}`)];

/** A repo with the plan, a fake whose scripts are keyed by group (the prompt's current-steps line), and a server. */
async function scenario(steps: StepSpec[], scripts: Record<string, Action[]>, repoConfig?: unknown) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "p.md"), plan(steps));
  if (repoConfig) writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(repoConfig));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  for (const [ids, actions] of Object.entries(scripts)) fake.scriptFor(`>>> CURRENT STEP(S): ${ids}\n`, ...actions);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const delegate = (stepsArg: string) => callText(server.client, "delegate", { plan: ".plan/p.md", steps: stepsArg });
  const inRepo = (file: string) => existsSync(join(repo.dir, file));
  const call = (name: string, args: Record<string, string>) => callText(server.client, name, args);
  return { repo, fake, delegate, inRepo, call };
}

const jobsIn = (text: string) => [...text.matchAll(/^\w+ (j[0-9a-z]{4}) step=(\S+)/gm)].map((m) => ({ job: m[1], step: m[2] }));
const batchOf = (text: string) => text.match(/^BATCH (b[0-9a-z]{4}) /)![1];

test("independent groups run concurrently in their own worktrees, land in step order, and report one batch block", async () => {
  const t: Record<string, number> = {};
  const seen: Record<string, boolean> = {};
  let dir = "";
  const { repo, fake, delegate, inRepo } = await scenario(
    [{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt" }],
    {
      // step 1 is slow: step 2 finishes first but must wait for step 1 to land
      "1": writes("a.txt", { hook: () => (t.start1 = Date.now()) }, { wait: 800 }, {
        hook: () => {
          t.end1 = Date.now();
          seen.bLanded = inRepo("b.txt");
          seen.bReady = readdirSync(join(dir, ".cheapag", "jobs")).some((j) => existsSync(join(dir, ".cheapag", "jobs", j, "diff.patch")));
        },
      }),
      "2": writes("b.txt", { hook: () => (t.start2 = Date.now()) }),
    },
  );
  dir = repo.dir;
  const text = await delegate("1,2");
  const [j1, j2] = jobsIn(text);
  const batch = batchOf(text);

  expect(t.start2).toBeLessThan(t.end1); // overlapping in time
  expect(seen).toEqual({ bLanded: false, bReady: true }); // step 2 was done, yet not landed before step 1
  expect(text.split("\n")[0]).toBe(`BATCH ${batch} groups=2 OK=2 landed=2 integration=pending cost=$0.000`);
  expect(text).toBe([
    `BATCH ${batch} groups=2 OK=2 landed=2 integration=pending cost=$0.000`,
    `OK ${j1.job} step=1 files=1 +1/-0 tests=none turns=2 cost=$0.000`,
    "summary: wrote a.txt",
    "changed:",
    "  A a.txt +1",
    `log: .cheapag/jobs/${j1.job}/`,
    "",
    `OK ${j2.job} step=2 files=1 +1/-0 tests=none turns=2 cost=$0.000`,
    "summary: wrote b.txt",
    "changed:",
    "  A b.txt +1",
    `log: .cheapag/jobs/${j2.job}/`,
  ].join("\n"));
  expect([j1.step, j2.step]).toEqual(["1", "2"]);
  expect(inRepo("a.txt") && inRepo("b.txt")).toBe(true);

  // separate worktrees, both removed after landing
  const dirs = fake.recorded.sessions.map((s) => s.directory).sort();
  expect(dirs).toEqual([j1.job, j2.job].map((j) => join(repo.dir, ".cheapag", "worktrees", j)).sort());
  expect(repo.git("worktree", "list").trim().split("\n")).toHaveLength(1);

  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "batches", `${batch}.json`), "utf8"));
  expect(record).toMatchObject({
    format: "cheapag/1", batch, plan: ".plan/p.md", steps: "1,2", groups: ["1", "2"], notes: [], integration: "pending",
    jobs: [j1.job, j2.job], landed: [j1.job, j2.job],
  });
  expect(record.endedAt).not.toBeNull();
  const job1 = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", j1.job, "result.json"), "utf8"));
  expect(job1).toMatchObject({ batch, steps: "1", status: "OK", landed: true });
});

test("groups whose files overlap are serialized in step order, with a note; the later one sees the earlier one's landing", async () => {
  const seen: Record<string, boolean> = {};
  let inRepo: (f: string) => boolean = () => false;
  const s = await scenario(
    [{ id: "1", files: "src/" }, { id: "2", files: "src/x.ts, docs.md" }],
    {
      "1": writes("src/x.ts"),
      "2": writes("docs.md", { hook: () => (seen.xLandedFirst = inRepo("src/x.ts")) }),
    },
  );
  inRepo = s.inRepo;
  const text = await s.delegate("2,1"); // written out of order: groups still run in step order
  expect(text.split("\n").slice(0, 2)).toEqual([expect.stringMatching(/ groups=2 OK=2 landed=2 /), "note: steps 1,2 serialized (src/x.ts)"]);
  expect(seen.xLandedFirst).toBe(true);
});

test("needs: a group waits for its dependency to land OK", async () => {
  const seen: Record<string, boolean> = {};
  let inRepo: (f: string) => boolean = () => false;
  const s = await scenario(
    [{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt", needs: "1" }],
    { "1": writes("a.txt", { wait: 300 }), "2": writes("b.txt", { hook: () => (seen.aLanded = inRepo("a.txt")) }) },
  );
  inRepo = s.inRepo;
  const text = await s.delegate("1,2");
  expect(text).toMatch(/ groups=2 OK=2 landed=2 /);
  expect(text).not.toContain("note:"); // ordered by needs, not by overlap
  expect(seen.aLanded).toBe(true);
});

test("a dependency that did not land OK: the dependent group is not started and reported FAIL; independent groups still run", async () => {
  const { fake, delegate, inRepo } = await scenario(
    [{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt", needs: "1" }, { id: "3", files: "c.txt" }],
    { "1": [{ error: { name: "APIError", message: "upstream 500" } }], "3": writes("c.txt") },
  );
  const text = await delegate("1,2,3");
  const jobs = jobsIn(text);
  expect(text.split("\n")[0]).toMatch(/^BATCH b[0-9a-z]{4} groups=3 FAIL=2 OK=1 landed=1 integration=pending cost=\$0\.000$/);
  const two = jobs.find((j) => j.step === "2")!;
  expect(text).toContain(`FAIL ${two.job} step=2 files=0 +0/-0 turns=0 cost=$0.000\nreason: needs 1 (FAIL)\nlog: .cheapag/jobs/${two.job}/`);
  expect(fake.recorded.sessions).toHaveLength(2); // step 2 never got a session
  expect(inRepo("c.txt")).toBe(true);
  expect(inRepo("b.txt")).toBe(false);
  // urgency order: FAILs before OK
  expect(jobs.map((j) => j.step).at(-1)).toBe("3");
});

test("max_parallel bounds how many groups run at once", async () => {
  const t: Record<string, number> = {};
  const timed = (n: string): Action[] => writes(`${n}.txt`, { hook: () => (t[`start${n}`] = Date.now()) }, { wait: 300 }, { hook: () => (t[`end${n}`] = Date.now()) });
  const { delegate } = await scenario([{ id: "1", files: "1.txt" }, { id: "2", files: "2.txt" }], { "1": timed("1"), "2": timed("2") }, { limits: { max_parallel: 1 } });
  expect(await delegate("1,2")).toMatch(/ groups=2 OK=2 landed=2 /);
  expect(t.start2 >= t.end1 || t.start1 >= t.end2).toBe(true);
});

test("a range runs as one job, its steps in order in one session, with a plain job block", async () => {
  const { fake, delegate } = await scenario([{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt" }], { "1, 2": writes("a.txt") });
  const text = await delegate("1-2");
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1-2 files=1 /);
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("a group that needs a later one fails immediately", async () => {
  const { fake, delegate } = await scenario([{ id: "1", files: "a.txt", needs: "2" }, { id: "2", files: "b.txt" }], {});
  expect(await delegate("1,2")).toBe('FAIL reason: plan .plan/p.md: steps "1,2": step 1 needs 2, which comes later in the plan; put dependencies first');
  expect(fake.recorded.sessions).toEqual([]);
});

test("a group waiting to land can be cancelled at once; it never lands, and later groups still land only after earlier ones", async () => {
  let dir = "";
  const { repo, delegate, inRepo, call } = await scenario(
    [{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt" }, { id: "3", files: "c.txt" }],
    { "1": writes("a.txt", { wait: 1500 }), "2": writes("b.txt"), "3": writes("c.txt") },
  );
  dir = repo.dir;
  const pending = delegate("1,2,3");
  // group 2 finished its work and is waiting for group 1 to land
  const step2 = await new Promise<string>((resolve) => {
    const poll = setInterval(() => {
      const jobs = existsSync(join(dir, ".cheapag", "jobs")) ? readdirSync(join(dir, ".cheapag", "jobs")) : [];
      const j = jobs.find((id) => existsSync(join(dir, ".cheapag", "jobs", id, "diff.patch")) &&
        JSON.parse(readFileSync(join(dir, ".cheapag", "jobs", id, "request.json"), "utf8")).steps === "2");
      if (j) {
        clearInterval(poll);
        resolve(j);
      }
    }, 20);
  });
  const t0 = Date.now();
  const cancelled = await call("jobs", { action: "cancel", job: step2 });
  expect(Date.now() - t0).toBeLessThan(1000); // not held until group 1 lands
  expect(cancelled.split("\n")[0]).toMatch(new RegExp(`^CANCELLED ${step2} step=2 `));
  const text = await pending;
  expect(inRepo("b.txt")).toBe(false);
  expect(inRepo("a.txt") && inRepo("c.txt")).toBe(true);
  const batch = JSON.parse(readFileSync(join(dir, ".cheapag", "batches", `${batchOf(text)}.json`), "utf8"));
  const [j1, , j3] = jobsIn(text).sort((a, b) => a.step.localeCompare(b.step)).map((j) => j.job);
  expect(batch.landed).toEqual([j1, j3]); // step order held even though group 2 settled early
}, 30_000);

test("a question inside a batch cannot block yet: it is rejected and the job says so in its risks", async () => {
  const { delegate } = await scenario(
    [{ id: "1", files: "a.txt" }, { id: "2", files: "b.txt" }],
    { "1": writes("a.txt", { question: "Which header style?", options: ["a", "b"] }), "2": writes("b.txt") },
  );
  const text = await delegate("1,2");
  expect(text).toContain("risks:\n  - the worker had a question it could not ask (parallel groups cannot block yet): Which header style?\n");
});
