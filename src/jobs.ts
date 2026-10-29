import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { redact, type Provider } from "./credentials.js";
import { holdOpencode, type Opencode } from "./opencode.js";
import { needsOf, overlap, parsePlan, PLAN_FORMAT, selectGroups, type Group, type Plan, type PlanStep } from "./plan.js";
import { failBlock, renderBatch, renderJob, type BatchRecord, type JobRecord } from "./report.js";
import { loadConfig, type Config } from "./config.js";
import { projectScripts, workerRuleset } from "./permissions.js";
import { consentGate } from "./consent.js";
import { chain, DIFFICULTIES, escalationSkip, modelName, recordSpend, runRouted, tierModel, usedBalance, type Difficulty, type Route } from "./routing.js";
import { checkAllows, envFailure, errorTail, runVerify, sameFailure, verifyCommands, type VerifyRun } from "./verify.js";
import { finishReport, openSession, releaseDirectory, type FinishReport, type Question, type RunResult, type Session } from "./worker.js";
import {
  conflictPaths, createWorktree, git, jobWorktree, land, leftoverMarkers, operationInProgress, projectRoot, reapply, removeWorktree, withLock, worktreeDiff,
  type Changed, type Worktree,
} from "./workspace.js";
import { isAlive, normalisePath } from "./platform.js";

/** Jobs: runs each group of plan steps as one job, start to landing, under per-job caps (several groups make a batch); lists, shows and cancels jobs. */

/**
 * The worker session's ruleset for this job. The step's own done-when checks are allowed exactly as written, so the
 * worker can check its work before finishing (Cheap Agent runs them anyway); the hard denylist still comes last.
 */
function rulesetFor(worktree: Worktree, cmds: string[], config: Config) {
  const { scripts, exact } = projectScripts(worktree.path);
  return workerRuleset({ scripts, exact: [...exact, ...cmds.flatMap(checkAllows)], allowCommands: config.allow_commands, linked: worktree.linked });
}

/** More rejections than this in one job earn a risk line. */
const MAX_QUIET_REJECTIONS = 5;

/** Ticket 33: a harder step earns proportionally more turns before its cap (defaults 25/50/75 for easy/medium/hard). */
const TURN_SCALE: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };
/** The turn cap for the escalation attempt after a turn-cap stop: its own, smaller budget (ticket 33). */
const ESC_TURNS = 15;
/** Fail fast applies only to fixes (ticket 37): a step or source naming any of these is a bug to reproduce first. */
const FIX_WORDS = /\b(bug|fix(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|error|crash(?:es|ed)?|regress(?:ion|ed)?|broken|incorrect|wrong|traceback|exception)\b/i;

/**
 * `brief`: a research scout brief (ticket 23.4), resolved to its text, handed to every worker of the delegation.
 * `source`: the user's request or the issue, verbatim (ticket 28), so the worker can check the step against it.
 */
export type DelegateInput = { plan: string; steps: string; note?: string; wait?: boolean; brief?: string; source?: string; difficulty?: Difficulty };
/** What the tool takes: a plan file and steps, or (one step, no plan file) an inline task with optional files and done-when. */
export type DelegateRequest = Partial<DelegateInput> & { task?: string; files?: string; done_when?: string };

/** A brief longer than this is cut in the worker's prompt. */
const MAX_BRIEF = 6_000;

/** A source longer than this is cut in the worker's prompt (the issue's head is what matters; comment threads trail). */
const MAX_SOURCE = 8000;

/** `source=`: the text itself, or a repo-relative file holding it (the benchmark writes the issue to one; a user may point at a ticket export). */
function resolveSource(root: string, source: string | undefined): string | undefined {
  const value = source?.trim();
  if (!value) return undefined;
  const file = join(root, value);
  const text = !value.includes("\n") && value.length < 512 && !isAbsolute(value) && existsSync(file) ? readFileSync(file, "utf8").trim() : value;
  return text.length > MAX_SOURCE ? `${text.slice(0, MAX_SOURCE)}\n[… cut at ${MAX_SOURCE} characters]` : text;
}

/** `brief=`: a research id (its block from the log) or the brief's text itself. */
function resolveBrief(root: string, brief: string | undefined): { text?: string } | { fail: string } {
  const value = brief?.trim();
  if (!value) return {};
  if (!/^r[0-9a-z]{4}$/.test(value)) return { text: value.slice(0, MAX_BRIEF) };
  const file = join(root, ".cheapag", "jobs", value, "result.txt");
  if (!existsSync(file)) return { fail: `brief ${value}: no research with that id (cleaned up?); pass the brief's text instead` };
  return { text: readFileSync(file, "utf8").trim().slice(0, MAX_BRIEF) };
}

/**
 * An inline task becomes a one-step plan under .cheapag/plans/ so everything downstream (records, integration checks,
 * re-delegation) sees an ordinary plan file. Without done_when, verification falls back to the repo's test_cmd.
 * shortcut: these plan files are never cleaned up; fold them into the job-log retention if they pile up.
 */
function inlinePlan(root: string, req: DelegateRequest): { plan: string } | { fail: string } {
  const task = req.task!.trim();
  if (!task) return { fail: "task is empty: say what to change, in which files, and how to check it" };
  if (req.plan || req.steps) return { fail: "give either task, or plan and steps, not both" };
  const indent = (text: string) => text.split(/\r?\n/).map((l, i) => (i ? "  " + l : l)).join("\n");
  const title = task.split(/\r?\n/)[0].slice(0, 70);
  const body = [`# ${title}`, "", "## 1 task", `files: ${req.files?.trim() || "./"}`, `do: ${indent(task)}`,
    `done-when: ${indent(req.done_when?.trim() || "the change described in do: is made and the existing tests still pass")}`, ""].join("\n");
  const rel = join(".cheapag", "plans", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}.md`);
  mkdirSync(join(root, ".cheapag", "plans"), { recursive: true });
  writeFileSync(join(root, rel), body);
  return { plan: rel };
}

/** What a tool call that may start workers gets from the server. */
export type WorkerContext = { provider: Provider; opencode: (route: Route) => Promise<Opencode>; progress: Progress };

export async function delegate(req: DelegateRequest, ctx: WorkerContext): Promise<string> {
  const root = projectRoot(process.cwd());
  // first: an unapproved repo gets CONSENT before any job, worktree, OpenCode boot or provider call
  const gate = consentGate(root, ctx.provider.provider);
  if ("block" in gate) return gate.block;
  const { route } = gate;
  let input: DelegateInput;
  const brief = resolveBrief(root, req.brief);
  if ("fail" in brief) return failBlock(brief.fail);
  const source = resolveSource(root, req.source);
  if (req.task !== undefined) {
    const made = inlinePlan(root, req);
    if ("fail" in made) return failBlock(made.fail);
    input = { plan: made.plan, steps: "1", note: req.note, wait: req.wait, brief: brief.text, source, difficulty: req.difficulty };
  } else if (req.plan && req.steps) input = { plan: req.plan, steps: req.steps, note: req.note, wait: req.wait, brief: brief.text, source, difficulty: req.difficulty };
  else return failBlock("give task (what to change, files, how to check), or plan and steps");
  // only the caller's path: an inline task's own plan lives under .cheapag/plans/
  if (req.task === undefined && input.plan.split(/[\\/]/).filter((p) => p && p !== ".")[0] === ".cheapag") return failBlock(`plan ${input.plan} is under .cheapag/, Cheap Agent's state folder, which workers cannot see; save plans under .plan/`);
  const planFile = join(root, input.plan);
  if (isAbsolute(input.plan) || !inside(root, planFile)) return failBlock(`plan ${input.plan} must be a path inside the repository, relative to its root`);
  if (!existsSync(planFile)) return failBlock(`plan ${input.plan} not found`);
  let plan: Plan;
  let groups: Group[];
  try {
    plan = parsePlan(readFileSync(planFile, "utf8"));
  } catch (err) {
    return failBlock(`plan ${input.plan}: ${(err as Error).message}\n${PLAN_FORMAT}`);
  }
  try {
    groups = selectGroups(plan, input.steps);
  } catch (err) {
    return failBlock(`plan ${input.plan}: ${(err as Error).message}`);
  }

  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  const busy = operationInProgress(root);
  if (busy) return failBlock(`${busy} in the working tree; finish or abort it, then delegate again`);

  // one boot with one route for every group: a config change would restart OpenCode under the batch's running jobs
  const opencode = await ctx.opencode(route);
  const release = holdOpencode();
  const shared = { root, input, plan, config, route, opencode, provider: ctx.provider, progress: ctx.progress };
  // wait=false: every group is RUNNING the moment it is created
  if (groups.length === 1) {
    const one = runGroup({ ...shared, group: groups[0], batch: null });
    void one.done.finally(release);
    return input.wait === false ? renderJob(one.record()) : one.outcome;
  }
  const run = runBatch(groups, shared);
  void run.all.catch(() => {}).finally(release);
  return input.wait === false ? run.render() : run.look(false, ctx.progress);
}

type Shared = { root: string; input: DelegateInput; plan: Plan; config: Config; route: Route; opencode: Opencode; provider: Provider; progress: Progress };

/** One group, one job: what `runGroup` needs beyond what the whole delegation shares. */
type GroupRun = Shared & {
  group: Group;
  batch: string | null;
  /**
   * Awaited before the job starts work (a batch's scheduling: overlap, needs, a worker slot); the job is recorded RUNNING
   * meanwhile. A reason means it must not start (a dependency did not land OK): the job is recorded as FAIL with it.
   */
  start?: Promise<string | undefined>;
  /** Awaited once the job is ready to land, before taking the lock: a batch lands its groups in step order. */
  beforeLand?: () => Promise<unknown>;
  /** Waits for a worker slot again before a redo's worker runs (batches: its slot was given back before landing). */
  beforeRedo?: () => Promise<unknown>;
  /** An integration fix job: the batch's landed steps fail `cmd` together, with this error tail; it verifies `cmd` only. */
  fix?: { cmd: string; error: string[] };
};

/**
 * Runs one group as one job, start to landing (spec: Job lifecycle). `outcome` is the first block a caller sees (BLOCKED,
 * or final); `done` resolves to the final block; `record()` is the job record as it stands; `settles()` resolves at the
 * job's next settlement (BLOCKED, or final).
 */
function runGroup(g: GroupRun) {
  const { root, input, plan, config, route, opencode } = g;
  const steps = g.group.steps;
  const cmds = g.fix ? [g.fix.cmd] : verifyCommands(steps.map((s) => s.fields["done-when"]), config.test_cmd);
  const { job, dir } = newJob(root);
  const write = (name: string, value: unknown) => writeWhole(join(dir, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"));
  const stepIds = g.group.label;
  // a step's own difficulty: wins over the call's; in a range the hardest step decides (ticket 26)
  const difficulty = [...DIFFICULTIES].reverse().find((d) => steps.some((s) => s.fields.difficulty === d)) ?? input.difficulty;
  const model = tierModel(route, difficulty);
  // against the implement model, so a tier model shows as model= in the headline
  const requested = modelName(route.implement);
  const startedAt = new Date();
  write("request.json", { ...input, steps: stepIds, batch: g.batch, model: modelName(model), difficulty, startedAt });

  const escalation = route.escalation;
  // the job's model, then its allowed fallbacks: a provider limit moves the session on to the next one
  const models = chain(model, route.fallbacks.filter((m) => modelName(m) !== modelName(model)));
  let billing: JobRecord["billing"];
  // whoever is waiting on this job right now: delegate first, then each reply
  let progress = g.progress;
  let settle!: (text: string) => void;
  const nextOutcome = () => new Promise<string>((resolve) => (settle = resolve));
  const outcome = nextOutcome();
  // every settlement also wakes `jobs wait` and a batch watching this job
  let pulse!: () => void;
  let settled = new Promise<void>((resolve) => (pulse = resolve));
  const announce = (text: string) => {
    settle(text);
    const wake = pulse;
    settled = new Promise<void>((resolve) => (pulse = resolve));
    wake();
  };
  let notStarted: string | undefined;
  let asked: NonNullable<JobRecord["question"]>[] | null = null;
  let blockedAt: Date | undefined;
  let expiry: NodeJS.Timeout | undefined; // max_blocked_minutes, while BLOCKED
  let worktree: Worktree | undefined;
  let session: Session | undefined;
  let report: FinishReport = finishReport({ text: "" });
  let changed: Changed[] = [];
  let reason: string | undefined;
  const verified: VerifyRun[] = [];
  const tried: string[] = [];
  let found: string | undefined; // a stopped worker's findings note (ticket 29)
  let selfFix = 0;
  let escalated = false;
  let repro: JobRecord["repro"]; // the server's check of the worker's reproduction test (OK jobs only)
  let reproRisk: string | undefined;
  let failing: { run: VerifyRun; tail: string[] } | undefined;
  let checked = false; // whether verify has seen the worker's latest changes
  let redone = 0; // 1 once a landing conflict started the redo (spec: Landing and redo)
  let conflict: string[] | undefined; // set when the redo could not land either: the job is CONFLICT

  // caps count across the whole job; any stop aborts the session, and all but the turn cap also kill verify
  const { limits } = config;
  // ticket 33: the turn cap scales with the step's difficulty, and the escalation attempt gets its own smaller one
  const scale = TURN_SCALE[difficulty ?? "easy"];
  let turnCap = limits.max_turns * scale;
  let turnBase = 0; // turns already spent when the current turn budget began (reset for the escalation attempt)
  const escCap = Math.min(limits.max_turns, ESC_TURNS);
  const halt = new AbortController(); // the worker session
  const kill = new AbortController(); // verify processes: a turn cap still runs one last check, so PARTIAL never hides failing tests
  let escTurn: AbortController | undefined; // the escalation attempt's own run, when it follows a turn-cap stop
  let stopped = undefined as Stop | undefined; // set from callbacks: keep TS from narrowing it to undefined
  let landing = false;
  const stop = (why: Stop) => {
    // a landing in progress finishes; a turn cap's last check may still be cut short by the clock or a cancel
    if (landing || (stopped && (stopped.cap !== "turns" || why.cap === "turns"))) return;
    stopped = why;
    clearTimeout(expiry);
    blocked.delete(job); // a reply arriving now must not resume a stopped job
    halt.abort();
    if (why.cap !== "turns") kill.abort();
    else escTurn?.abort(); // a turn cap during the escalation attempt ends that run too (it runs after `halt` aborted)
  };
  const overCost = () => {
    if (session && session.totals().usage.costUsd >= limits.max_cost_usd) stop({ cap: "cost", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
  };
  const overTurns = () => {
    if (session && session.totals().turns - turnBase >= turnCap) stop({ cap: "turns", reason: `turn cap (${turnCap}) reached` });
  };
  // fail fast (ticket 28): a step with checks that has no test file in its worktree by repro_by_turns stops now, so Claude
  // takes over without a 40-turn failed job in its context (v2 hard tier: FAIL sessions averaged 482k Claude tokens, stock 385k)
  // shortcut: counts any test file in the worktree's status, carried-over dirty ones included; tighten to the job's own edits if that misfires
  // ticket 37: only a fix has a bug to reproduce; a feature step is never stopped for lacking a test
  const isFix = g.fix || FIX_WORDS.test([...steps.map((s) => `${s.title} ${s.fields.do ?? ""}`), input.source ?? ""].join("\n"));
  let reproSeen = false;
  let carried = new Set<string>(); // paths already dirty when the worktree opened (carried over from the repo): not the worker's edits
  const dirty = () => git(worktree!.path, ["status", "--porcelain"]).split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  const reproDue = () => {
    if (reproSeen || !isFix || !cmds.length || !worktree || !session || session.totals().turns < limits.repro_by_turns * scale) return;
    // a started fix (a changed non-test file) gets double the turns to prove it; the worker may just not have written its test yet
    const files = dirty();
    const started = files.some((f) => !TEST_FILE.test(f) && !carried.has(f));
    const by = limits.repro_by_turns * scale * (started ? 2 : 1);
    if (session.totals().turns < by) return;
    reproSeen = files.some((f) => TEST_FILE.test(f));
    if (!reproSeen) stop({ cap: "turns", reason: `no reproduction test by turn ${by}; ${started ? "the fix was started but never proven" : "the worker was still exploring"}` });
  };
  // the minute cap counts working time only: the clock is paused while the job waits BLOCKED on a reply
  let clockLeft = limits.max_minutes * 60_000;
  let clockStarted = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const startClock = () => {
    clockStarted = Date.now();
    timer = setTimeout(() => stop({ cap: "minutes", reason: `minute cap (${limits.max_minutes} min) reached` }), clockLeft);
  };
  const pauseClock = () => {
    if (timer === undefined) return; // not started yet, or already paused: never count the same stretch twice
    clearTimeout(timer);
    timer = undefined;
    clockLeft -= Date.now() - clockStarted;
  };
  let finished!: (text: string) => void;
  const done = new Promise<string>((resolve) => (finished = resolve));
  const halted = new Promise<void>((resolve) => (halt.signal.aborted ? resolve() : halt.signal.addEventListener("abort", () => resolve(), { once: true })));
  let parked = false; // finished, waiting for earlier groups to land: it can only move once they settle
  running.set(job, { stop, done, batch: g.batch, settles: () => settled, block: () => renderJob(last), parked: () => parked });

  /** Runs the done conditions in the worktree; returns the failing run and its error tail, if any. */
  const verify = async () => {
    const runs = await runVerify(worktree!.path, cmds, (cmd) => progress(session!.totals().turns, `verify: ${cmd}`), kill.signal);
    checked = true;
    verified.push(...runs);
    // the full output stays on disk; Claude only ever sees the tail
    for (const r of runs) appendFileSync(join(dir, "verify.log"), redact(`$ ${r.cmd}\n${r.output}\n(exit ${r.ok ? "ok" : "failed"}, ${r.ms} ms)\n\n`));
    const run = runs.find((r) => !r.ok);
    return run && { run, tail: errorTail(run, worktree!.path) };
  };

  let last!: JobRecord;
  /** Builds the job record as it stands, writes it and returns its block. */
  const finalize = (status: JobRecord["status"]) => {
    const landed = status === "OK";
    // a BLOCKED worker has not finished: no report, no verify yet (the renderer omits what is absent)
    const waiting = status === "BLOCKED";
    const silent = waiting || notStarted !== undefined; // likewise a group that never started
    const rejections = session?.totals().rejections ?? [];
    // server risks go first, so the 5-risk cap never cuts them
    const risks = [
      ...(reproRisk ? [reproRisk] : []),
      ...(report.disagree && !/^none\b/i.test(report.disagree) ? [`spec vs source: ${report.disagree}`] : []),
      ...(rejections.length > MAX_QUIET_REJECTIONS ? [`${rejections.length} tool calls or permission requests were rejected; check the worker stayed in scope (see the log)`] : []),
      ...report.risks,
    ];
    // a failing check that could not run at all (missing tool, broken Node) reads as an environment failure, not bad code
    const env = failing ? envFailure(failing.run) : undefined;
    const record = {
      format: "cheapag/1" as const, job, batch: g.batch, kind: g.fix ? "fix" : "implement", status, landed,
      plan: input.plan, steps: stepIds, provider: g.provider.provider,
      // the server process running the job: a restart finds RUNNING/BLOCKED records whose pid is gone
      pid: process.pid,
      models: {
        requested, final: modelName(escalated ? escalation! : models.current), escalated,
        fallbacks: models.used,
      },
      difficulty,
      billing,
      // tree: what the worktree's diff is measured against, so `land apply` can land it later
      baseline: { head: worktree?.head ?? null, stash: worktree?.stash ?? null, tree: worktree?.base ?? null },
      worktree: !landed && worktree ? normalisePath(relative(root, worktree.path)) : null,
      sessionID: session?.sessionID ?? null,
      // server-measured: "none" when nothing ran (no conditions, or the worker failed before verify)
      tests: silent ? undefined : ((!verified.length ? "none" : failing ? "fail" : "pass") as JobRecord["tests"]),
      error: failing ? (env ? [env, ...failing.tail] : failing.tail) : undefined,
      ...(env && { check: "env" as const }),
      tried, ...(found && { found }),
      summary: silent ? "" : report.summary, changed, risks: silent ? [] : risks,
      ...(changed.some((c) => TEST_FILE.test(c.path)) && { test: changed.find((c) => TEST_FILE.test(c.path))!.path }),
      // a landed job's files are in the working tree; an unlanded one's only in its worktree
      review: reviewRanges(report.review, landed || !worktree ? root : worktree.path),
      // a worker stopped by a cap rarely says what it left undone
      missing: status === "PARTIAL" && !report.missing.length ? [`unknown: stopped (${stopped?.reason ?? "cap"}); compare the diff with the step`] : report.missing,
      reason, conflict,
      verify: verified.map(({ cmd, ok, ms }) => ({ cmd, ok, ms })), selfFix, redo: redone, ...(repro && { repro }), question: asked?.length === 1 ? asked[0] : null, ...(asked && asked.length > 1 && { questions: asked }), autoRejected: rejections,
      usage: { turns: session?.totals().turns ?? 0, ...(session?.totals().usage ?? { costUsd: 0 }) },
      timing: { startedAt, endedAt: status === "RUNNING" || waiting ? null : new Date(), ms: Date.now() - startedAt.getTime(), ...(waiting && { blockedAt }) },
    };
    last = record;
    const text = renderJob(record);
    write("result.json", { ...record, blockTokensApprox: Math.ceil(text.length / 4) });
    write("result.txt", text + "\n");
    return text;
  };

  /** The worker asked: the job is BLOCKED, its block goes to whoever waits, and the session stays paused until `reply` resumes it. */
  const onQuestion = (questions: Question[]) => new Promise<string[]>((answer) => {
    pauseClock();
    asked = questions.map((q) => ({ text: q.question, options: q.options, answer: null }));
    changed = worktreeDiff(worktree!).changed;
    blockedAt = new Date();
    // a forgotten question must not hold the session, the worktree and a worker slot forever
    expiry = setTimeout(() => stop({ cap: "cancel", reason: `no reply within ${limits.max_blocked_minutes} min` }), limits.max_blocked_minutes * 60_000).unref();
    blocked.set(job, {
      job, questions,
      resume: (answers, replyProgress) => {
        clearTimeout(expiry);
        blockedAt = undefined;
        blocked.delete(job);
        startClock();
        progress = replyProgress;
        asked = questions.map((q, i) => ({ text: q.question, options: q.options, answer: answers[i] }));
        const after = nextOutcome();
        answer(answers);
        finalize("RUNNING"); // a batch block shown before its next turn must not repeat the answered question
        return after;
      },
    });
    announce(finalize("BLOCKED"));
  });

  /**
   * Its patch clashed with the working tree on landing (spec: Landing and redo): the tree is untouched, and one redo
   * applies the change again onto a fresh worktree of the current state, then takes the normal path in the same
   * session (same job, so caps and usage carry on). It lands OK with redo=1, or sets `conflict`: the files, and the jobs
   * that changed them meanwhile. Called where the job lands, so a batch's landing order holds.
   */
  const redo = async (patch: string, clash: string, work: (prompt: string, tag: string) => Promise<RunResult>) => {
    redone = 1;
    write("conflict.patch", patch); // log copy of the change that clashed
    await releaseDirectory(worktree!.path); // release before the path is removed, then recreated
    removeWorktree(root, worktree!);
    // the same path, so the session's directory stays valid
    worktree = createWorktree(root, job, config.link_dirs);
    const marked = reapply(worktree, patch);
    const named = conflictPaths(clash);
    const files = marked.length ? marked : named.length ? named : changed.map((c) => c.path);
    landing = false;
    await Promise.race([g.beforeRedo?.(), halted]); // max_parallel counts a redo's worker too
    startClock();
    finalize("RUNNING");
    const result = await work(redoPrompt(steps, files, marked, patch), "redo ");
    write("finish.json", report);
    const diff = worktreeDiff(worktree);
    changed = diff.changed;
    write("diff.patch", diff.patch);
    if (stopped) return; // the cap or cancel explains it
    let why = result.error ? "redo worker error"
      : failing ? "redo failed verification"
      : leftoverMarkers(worktree).length ? "redo left conflict markers"
      : !diff.changed.length ? "redo made no changes"
      : undefined;
    if (!why) {
      landing = true;
      pauseClock();
      if (!(await land(root, job, diff.patch, diff.changed.map((c) => c.path)))) {
        await releaseDirectory(worktree.path);
        removeWorktree(root, worktree);
        return;
      }
      why = "redo could not reconcile";
    }
    const others = landedSince(root, job, startedAt);
    conflict = files.map((f) => {
      const by = others.filter((r) => r.changed.some((c) => c.path === f)).map((r) => r.job);
      return `${f} (${by.length ? `also changed by ${by.join(", ")}, landed first` : "changed in the working tree meanwhile"}; ${why})`;
    });
  };

  finalize("RUNNING");
  // the job outlives this call when it blocks: it settles each outcome in turn (BLOCKED, then whatever follows a reply)
  void (async () => {
    try {
      notStarted = await Promise.race([g.start, halted.then(() => undefined)]);
      if (notStarted) throw new Error(notStarted);
      if (stopped as Stop | undefined) throw new Error("stopped before it started"); // cancelled while queued; the stop's reason is recorded
      startClock(); // queued time is not working time
      worktree = createWorktree(root, job, config.link_dirs);
      carried = new Set(dirty());
      session = await openSession({
        opencode,
        directory: worktree.path,
        model,
        permission: rulesetFor(worktree, cmds, config),
        // nobody watches a fix job for a BLOCKED block: its questions are rejected (with a risk line)
        onQuestion: g.fix ? undefined : onQuestion,
        signal: halt.signal,
        onEvent: (event, turns) => {
          appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
          // one progress notification per worker turn; finer events (deltas, usage) would only be noise in /tasks
          if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
            const part = event.properties.part;
            if (part.state.status === "completed" || part.state.status === "error") {
              progress(turns, `turn ${turns}: ${part.tool}`);
              if (!stopped && !blocked.has(job)) finalize("RUNNING"); // so `jobs list`/`show` see live turns
              // finishing on the last allowed turn is fine
              if (part.tool !== "finish") {
                overTurns();
                reproDue();
              }
            }
          }
          if (event.type === "message.updated") overCost();
        },
      });
      finalize("RUNNING"); // now with the worktree, so a restart can point at it
      const provider = g.provider.provider;
      // a provider limit is not a cap: the worker aborts the session itself and the job falls back, or stops as BUDGET
      const routed = async (text: string, on?: typeof escalation, interrupt?: AbortSignal) => {
        const r = await runRouted(session!, text, models, provider, on, interrupt);
        if (r.budget) stopped ??= { cap: "provider", reason: r.budget };
        return r;
      };
      /** One prompt through the normal path: the run, then verify with up to 2 self-fixes and 1 escalation. `tag` prefixes tried: lines. */
      const work = async (prompt: string, tag = "") => {
        // no hand-over at the turn cap (ticket 28): it rescued nothing in the model bake-off and doubled a failed job's length
        let result = await routed(prompt);
        report = finishReport(result);
        failing = undefined;
        checked = false;
        if (!result.error && cmds.length) {
          failing = await verify();
          // up to 2 self-fixes in the same session, then 1 escalation on the stronger model (spec: Job lifecycle)
          for (const attempt of ["fix 1", "fix 2", "esc"] as const) {
            if (!failing) break;
            // the check could not run (missing tool, broken Node): no edit fixes that, so fixes and the escalation would only burn turns
            const env = envFailure(failing.run);
            if (env) {
              tried.push(`${tag}env: the check could not run (${env})`);
              break;
            }
            overTurns(); // a fix needs at least one more turn
            if (stopped as Stop | undefined) break; // a cap, cancel or provider budget (cast: set from callbacks, keep TS from narrowing)
            const esc = attempt === "esc";
            if (esc && escalated) break; // already used for the turn-cap hand-over
            const skip = esc && escalationSkip(escalation, models, config.escalation_skip_at, session!.totals().spend);
            if (skip) {
              tried.push(tag + skip);
              break;
            }
            if (esc) escalated = true;
            else selfFix++;
            const before: string[] = failing.tail;
            result = await routed(`Verification failed. Fix the cause, then call finish again.\n\n${before.join("\n")}`, esc ? escalation : undefined);
            checked = false;
            // an attempt that reports nothing keeps the last real report rather than a placeholder
            const fresh = result.finish || /```cheapag-result/.test(result.text) ? finishReport(result) : undefined;
            if (fresh) report = fresh;
            const label = `${tag}${esc ? "esc" : attempt}: ${(fresh?.summary ?? "(no summary)").slice(0, 100)}`;
            if (result.limit && esc) {
              tried.push(`${label} → usage limit: ${result.limit.message.slice(0, 80)}`);
              escalated = false; // it never ran: the job ends on the implement chain's model and result
              break;
            }
            if (result.error) {
              tried.push(`${label} → ${stopped ? `stopped: ${stopped.reason}` : "worker error"}`);
              break;
            }
            failing = await verify();
            tried.push(`${label} → ${!failing ? "passed" : sameFailure(before, failing.tail) ? "same failure" : "different failure"}`);
          }
        }
        // stopped mid-change by the turn cap: check what the worker left, to tell PARTIAL from FAIL
        if (stopped?.cap === "turns" && cmds.length && !checked) failing = await verify();
        return result;
      };
      // an absolute repo path typed in a task would point the worker outside its worktree
      const rootRe = new RegExp([...new Set([root, realpathSync(root)])].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"); // one pass: the worktree path contains the root
      const inWorktree = (text: string) => text.replace(rootRe, () => worktree!.path);
      let result = await work(g.fix ? fixPrompt(plan, steps, g.fix) : inWorktree(contextPack(plan, steps, input.note, input.brief, input.source)));
      write("finish.json", report);
      // ticket 33: a turn cap during verify/fixes no longer loses the escalation. With a diff and a failing check it
      // still runs once on the escalation model, on its own smaller budget; a cap reached here ends the job as before.
      const escSkip = escalated || !failing || envFailure(failing.run) || !cmds.length || !worktree || !session ? "not now" : escalationSkip(escalation, models, config.escalation_skip_at, session.totals().spend);
      if (stopped?.cap === "turns" && !escSkip && worktreeDiff(worktree!).changed.length) {
        escalated = true;
        turnBase = session!.totals().turns;
        turnCap = escCap;
        escTurn = new AbortController();
        stopped = undefined; // the escalation replaces the turn-cap stop
        const before = failing!.tail;
        result = await session!.run(`Verification failed. Fix the cause, then call finish again.\n\n${before.join("\n")}`, escalation, escTurn.signal, true);
        const fresh = result.finish || /```cheapag-result/.test(result.text) ? finishReport(result) : undefined;
        if (fresh) report = fresh;
        write("finish.json", report);
        const label = `esc: ${(fresh?.summary ?? "(no summary)").slice(0, 100)}`;
        if (result.error || result.interrupted) {
          tried.push(`${label} → ${(stopped as Stop | undefined) ? `stopped: ${(stopped as Stop | undefined)!.reason}` : result.limit ? `usage limit: ${result.limit.message.slice(0, 80)}` : "worker error"}`);
        } else {
          failing = await verify();
          tried.push(`${label} → ${!failing ? "passed" : sameFailure(before, failing.tail) ? "same failure" : "different failure"}`);
        }
      }
      const diff = worktreeDiff(worktree);
      changed = diff.changed;
      write("diff.patch", diff.patch); // the log copy is redacted; landing applies the in-memory patch
      // ticket 29: a capped worker leaves Claude what it learned, so the take-over does not re-read the same files (after the diff, so the note turn cannot change the result)
      const cap = (stopped as Stop | undefined)?.cap;
      if (cap === "turns" || cap === "minutes" || cap === "cost") found = await findings(session!);
      if (stopped) {
        // a capped or cancelled job never lands; its worktree is kept
      } else if (result.error) {
        reason = `worker error: ${result.error}`;
      } else if (!failing) { // a verify failure is explained by the error: and tried: sections, not a reason
        ({ repro, risk: reproRisk } = await checkRepro(worktree.path, report.repro, [...cmds, ...(config.test_cmd ? [config.test_cmd] : []), ...config.allow_commands], diff.changed.map((c) => c.path), kill.signal));
        // waiting for earlier groups to land is still cancellable; the clock is paused, since an earlier group may sit BLOCKED for long
        pauseClock();
        parked = true;
        await Promise.race([g.beforeLand?.(), halted]);
        parked = false;
        if (!stopped) {
          landing = true; // from here on, caps and cancel no longer apply (until a redo works again)
          pauseClock();
          const clash = await land(root, job, diff.patch, diff.changed.map((c) => c.path));
          if (!clash) {
            await releaseDirectory(worktree.path);
            removeWorktree(root, worktree);
          } else await redo(diff.patch, clash, work);
        }
      }
    } catch (err) {
      reason = (err as Error).message;
    }
    clearTimeout(timer);
    running.delete(job);
    blocked.delete(job);
    if (session) {
      // Go windows are per account: the user-wide ledger decides later escalations and shows balance use
      try {
        recordSpend(session.totals().spend);
        if (g.provider.provider === "opencode-go" && usedBalance(session.totals().spend)) billing = "zen";
      } catch {
        // the ledger only steers later escalations: a write error (full disk, permissions) must not change this job's result
      }
    }
    let status: JobRecord["status"] = !stopped && reason === undefined && !failing ? "OK" : "FAIL";
    if (stopped) {
      // the cap or cancel explains the stop, not the aborted prompt's error
      reason = stopped.reason;
      status = stopped.cap === "turns" ? (changed.length && !failing ? "PARTIAL" : "FAIL") : STOPPED[stopped.cap];
      if (status === "PARTIAL") reason = undefined; // spec D5: PARTIAL says it through missing:
    } else if (conflict) status = "CONFLICT";
    const text = finalize(status);
    finished(text);
    announce(text);
  })().catch((err: Error) => {
    clearTimeout(timer);
    running.delete(job);
    blocked.delete(job);
    reason = err.message;
    let text: string;
    try {
      text = finalize("FAIL"); // never leave a RUNNING/BLOCKED record behind for this live process
    } catch {
      text = failBlock(err.message);
    }
    finished(text);
    announce(text);
  });
  return { job, outcome, done, record: () => last, settles: () => settled };
}

/**
 * Several groups (spec: Plan format contract, D6): each runs as its own job, up to `max_parallel` at once. A group whose
 * `files:` overlap an earlier group's starts after that one settles (with a note); a group with `needs:` starts after its
 * dependencies land OK, or is recorded FAIL without starting. Groups land in step order. Every group's job is created at
 * once (RUNNING until it starts), so any batch block can show it. `all` resolves when every group settled; `look` is the
 * batch block at the next point Claude should see it (spec: Job lifecycle, early return).
 */
function runBatch(groups: Group[], shared: Shared) {
  const { root, config } = shared;
  const dir = join(root, ".cheapag", "batches");
  mkdirSync(dir, { recursive: true });
  let batch: string;
  do batch = newId("b");
  while (existsSync(join(dir, `${batch}.json`)));
  const startedAt = new Date();
  const notes: string[] = [];
  const after = groups.map((g, i) => groups.slice(0, i).flatMap((earlier, j) => {
    const path = overlap(earlier, g);
    if (!path) return [];
    notes.push(`steps ${earlier.label},${g.label} serialized (${path})`);
    return [j];
  }));
  // shortcut: a need outside this delegation is not checked (it may have landed in an earlier call); check job records if plans rely on it
  const needs = groups.map((g) => needsOf(g).flatMap((id) => {
    const j = groups.findIndex((o) => o.steps.some((s) => s.id === id));
    return j < 0 ? [] : [{ id, j }];
  }));
  const ids: string[] = []; // by group
  const finals: (JobRecord | undefined)[] = [];
  const cmd = config.integration_cmd ?? config.test_cmd;
  const state: Integration = { integration: cmd ? "pending" : "none", verify: [] };
  let fix: ReturnType<typeof runGroup> | undefined;
  const record = (): BatchRecord => ({ format: "cheapag/1", batch, groups: groups.map((g) => g.label), notes, ...state, jobs: ids.filter(Boolean) });
  const write = () => {
    const ended = finals.filter((r) => r !== undefined);
    const landed = ended.filter((r) => r.landed).map((r) => r.job); // in landing order: groups land in step order
    const { plan, steps } = shared.input;
    const endedAt = ended.length === groups.length ? new Date() : null;
    writeWhole(join(dir, `${batch}.json`), redact(JSON.stringify({ ...record(), plan, steps, landed, startedAt, endedAt }, null, 2) + "\n"));
  };

  // worker slots: held while a worker runs (BLOCKED included: its worktree and session stay live, and a reply resumes it at
  // once), released before waiting to land, so a later group can never starve an earlier one
  let free = config.limits.max_parallel;
  const queue: (() => void)[] = [];
  const acquire = () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((resolve) => queue.push(resolve)));
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else free++;
  };

  // whoever is looking at the batch right now (delegate, a reply, a wait); nobody between looks
  let progress: Progress = () => {};
  const forward: Progress = (turns, message) => progress(turns, message);
  // overlap and needs only ever point at earlier groups (selectGroups rejects a need on a later one), so nothing waits in a cycle
  const settled: Promise<JobRecord>[] = [];
  // a group lands only after every earlier group has settled: a cancelled or BLOCKED group holds back its successors
  const turns: Promise<unknown>[] = [];
  const runs = groups.map((group, i) => {
    let holding = false;
    const releaseSlot = () => {
      if (holding) release();
      holding = false;
    };
    const start = (async () => {
      await Promise.all(after[i].map((j) => settled[j]));
      const deps = await Promise.all(needs[i].map(async ({ id, j }) => ({ id, status: (await settled[j]).status })));
      const failed = deps.find((d) => d.status !== "OK");
      if (failed) return `needs ${failed.id} (${failed.status})`;
      await acquire();
      holding = true;
    })();
    const run = runGroup({
      ...shared, progress: forward, group, batch, start,
      beforeLand: () => (releaseSlot(), turns[i - 1]),
      beforeRedo: () => acquire().then(() => (holding = true)),
    });
    ids[i] = run.job;
    settled[i] = (async () => {
      await run.done;
      void start.then(releaseSlot, () => {}); // a group cancelled while queued gives back the slot it gets later
      const final = run.record();
      finals[i] = final;
      write();
      return final;
    })();
    turns[i] = Promise.all([settled[i], turns[i - 1]]);
    return run;
  });
  write();
  // a group left unlanded runs the check later, from `land`, once nothing is left to land
  const all = Promise.all(settled).then(async (ended) => {
    if (cmd && allLanded(ended)) await integrate(root, cmd, batch, state, ended.map((r) => r.landed), write, async () => ({ ...shared, progress: forward }), (run) => (fix = run));
    return ended;
  });
  // jobs in group order (renderBatch sorts by urgency)
  const render = () => renderBatch(record(), runs.map((r) => r.record()), fix?.record());
  const live = () => runs.filter((r) => running.has(r.job) && !blocked.has(r.job));
  // nothing can move without a reply: every group still live is parked (waiting to land behind a BLOCKED one)
  const stuck = () => anyBlocked() && live().every((r) => running.get(r.job)?.parked());
  const anyBlocked = () => runs.some((r) => blocked.has(r.job));
  /**
   * Waits for the next settlement (`once`), or until a group is BLOCKED or every group settled, then returns the batch
   * block. With nothing left working it returns at once: a BLOCKED group only moves on a reply.
   */
  const look = async (once: boolean, to: Progress) => {
    progress = to;
    try {
      do {
        const working = live();
        if (!working.length || stuck()) break; // waiting would hang: a BLOCKED group only moves on a reply
        await Promise.race(working.map((r) => r.settles()));
      } while (!once && !anyBlocked());
      if (!live().length && !anyBlocked()) await all; // every group settled: the batch record is complete
      return render();
    } finally {
      if (progress === to) progress = () => {};
    }
  };
  const entry = { look, render, forward };
  batches.set(batch, entry);
  void all.catch(() => {}).then(() => batches.delete(batch)); // a rejection reaches whoever looks
  return { all, ...entry };
}

/** A batch record's integration check fields; `verify` holds each check's run (its output is not kept). */
type Integration = Pick<BatchRecord, "integration" | "integrationError" | "fix"> & { verify: Omit<VerifyRun, "output">[] };

/** Every group has ended with nothing left to land (each landed, was discarded or never got a worktree), and something did land. */
const allLanded = (jobs: Pick<JobRecord, "landed" | "worktree" | "status">[]) =>
  jobs.every((j) => j.status !== "RUNNING" && j.status !== "BLOCKED" && (j.landed || !j.worktree)) && jobs.some((j) => j.landed);

/**
 * The integration check (spec: Job lifecycle, A3 item 3): `cmd` on the combined working tree, under the land lock. A
 * failure starts one fix job on a fresh worktree of the combined state, on the normal path (self-fixes, escalation,
 * landing): integration passes when it lands OK, else fails with the check's error. `save` records each state change;
 * `fixer` gives what the fix job needs, only once one is needed (it may boot OpenCode).
 */
async function integrate(
  root: string, cmd: string, batch: string, state: Integration, landed: boolean[], save: () => void, fixer: () => Promise<Shared>, started: (fix: ReturnType<typeof runGroup>) => void,
) {
  try {
    state.integration = "running";
    save();
    // shortcut: the lock is held for the whole check, so a check longer than the lock timeout (10 min) makes other landings FAIL; split the lock if suites get that long
    const [run] = await withLock(root, () => runVerify(root, [cmd], () => {}));
    state.verify.push({ cmd: run.cmd, ok: run.ok, ms: run.ms, code: run.code, signal: run.signal });
    if (run.ok) {
      state.integration = "pass";
      return;
    }
    const error = errorTail(run, root);
    const shared = await fixer();
    const groups = selectGroups(shared.plan, shared.input.steps).filter((_, i) => landed[i]); // discarded groups are not in this code
    const fix = runGroup({ ...shared, group: { label: groups.map((g) => g.label).join(","), steps: groups.flatMap((g) => g.steps) }, batch, fix: { cmd, error } });
    state.fix = fix.job;
    started(fix);
    save();
    await fix.done;
    // shortcut: a fix that landed OK passes without checking the tree again (its own verify ran cmd on the combined state); re-check if the tree can drift meanwhile
    if (fix.record().status === "OK") state.integration = "pass";
    else Object.assign(state, { integration: "fail", integrationError: error });
  } catch (err) {
    Object.assign(state, { integration: "fail", integrationError: [`integration check: ${(err as Error).message}`] });
  } finally {
    save();
  }
}

/** Batches with a group still live in this server process, by id: how `jobs wait` and `reply` attach to them. */
const batches = new Map<string, { look: (once: boolean, progress: Progress) => Promise<string>; render: () => string; forward: Progress }>();

/** Why a job was stopped before it could finish: a cap, or `jobs cancel`. */
/** A test file, by the usual conventions: a tests/ directory, test_x / x_test / x.test / x.spec names, conftest.py. */
const TEST_FILE = /(^|\/)(tests?|testing|__tests__)\/|(^|\/)(test_[^/]*|[^/]*_tests?\.[a-z]+|[^/]*\.(test|spec)\.[a-z]+|conftest\.py)$/i;

/**
 * Checks the worker's reproduction test (ticket 24.1): its command must pass on the fixed tree and fail once the non-test
 * changes are set aside, which proves it tests the problem. The command comes from the worker, so it only runs when it
 * starts with a command this job may already run (done-when, test_cmd, allow_commands); anything else stays unverified.
 */
const FINDINGS_PROMPT = "You were stopped before finishing. Without calling any tool, answer in at most 600 characters: where the bug is (file:function), your best hypothesis, and what you ruled out.";
const FINDINGS_MS = 30_000;

/** One last prompt on a stopped session for its findings; any error, timeout or empty answer gives none. */
async function findings(session: Session): Promise<string | undefined> {
  try {
    const r = await session.run(FINDINGS_PROMPT, undefined, AbortSignal.timeout(FINDINGS_MS), true);
    const text = (r.error || r.interrupted ? "" : r.text || r.finish?.summary || "").replace(/\s+/g, " ").trim();
    return text ? (text.length > 600 ? `${text.slice(0, 599)}…` : text) : undefined;
  } catch {
    return undefined;
  }
}

async function checkRepro(cwd: string, claim: string | undefined, allowed: string[], changed: string[], signal: AbortSignal): Promise<{ repro?: JobRecord["repro"]; risk?: string }> {
  if (!claim || /^n\/?a\b/i.test(claim)) return {};
  if (/^none\b/i.test(claim)) return { repro: "none", risk: `no reproduction: ${claim.replace(/^none:?\s*/i, "") || "the worker could not reproduce the problem"}` };
  const runs = (cmd: string) => runVerify(cwd, [cmd], () => {}, signal).then((r) => r[0]?.ok ?? false);
  const unverified = (why: string) => ({ repro: "unverified" as const, risk: `reproduction not verified: ${why}` });
  if (!allowed.some((a) => claim === a || claim.startsWith(a + " "))) return unverified(`\`${claim}\` is not one of this job's check commands`);
  if (!(await runs(claim))) return unverified(`\`${claim}\` fails on the fixed code`);
  const fix = changed.filter((p) => !TEST_FILE.test(p));
  if (!fix.length) return unverified("the change has no code outside tests");
  // set the fix aside (tests stay), run the reproduction, then restore; landing uses the diff taken before this
  try {
    git(cwd, ["stash", "push", "--include-untracked", "--quiet", "--", ...fix]);
  } catch {
    return unverified("could not set the fix aside to rerun the reproduction");
  }
  let failsWithout = false;
  try {
    failsWithout = !(await runs(claim));
  } finally {
    // a failed restore only affects the worktree: the landing applies the diff taken before this check
    try {
      git(cwd, ["stash", "pop", "--quiet"]);
    } catch {
      failsWithout = false;
    }
  }
  return failsWithout ? { repro: "fail→pass" } : unverified(`\`${claim}\` also passes without the fix`);
}

type Stop = { cap: "turns" | "minutes" | "cost" | "cancel" | "provider"; reason: string };
const STOPPED = { minutes: "TIMEOUT", cost: "BUDGET", cancel: "CANCELLED", provider: "BUDGET" } as const;

/**
 * Jobs running in this server process, by id: how `jobs cancel` and `jobs wait` reach them. `done` resolves to the final
 * block, `settles()` at the next settlement (BLOCKED or final); `block()` is the current block.
 */
const running = new Map<string, { stop: (why: Stop) => void; done: Promise<string>; batch: string | null; settles: () => Promise<void>; block: () => string; parked: () => boolean }>();

export type JobsInput = { action: "list" | "show" | "wait" | "cancel"; job?: string };

/** The `jobs` tool: list jobs, show one's last block again, wait for a job's or batch's next settlement, or cancel a running job. */
export async function jobs(input: JobsInput, progress: Progress = () => {}): Promise<string> {
  const root = projectRoot(process.cwd());
  if (input.action === "list") {
    const all = records(root).sort((a, b) => String(b.timing?.startedAt ?? "").localeCompare(String(a.timing?.startedAt ?? "")));
    if (!all.length) return "no jobs yet";
    const lines = all.slice(0, LIST_MAX).map((r) => renderJob(r).split("\n")[0] + blockedFor(r));
    if (all.length > LIST_MAX) lines.push(`… +${all.length - LIST_MAX} older`);
    return lines.join("\n");
  }
  if (input.action === "wait" && input.job && /^b[0-9a-z]{4}$/.test(input.job)) return waitBatch(root, input.job, progress);
  // the id becomes a path: only well-formed ids get that far
  if (!input.job || !/^j[0-9a-z]{4}$/.test(input.job)) return failBlock(`jobs ${input.action} needs a job id, e.g. j7f3a${input.action === "wait" ? " or a batch id, e.g. b4k1x" : ""}`);
  const live = running.get(input.job);
  if (input.action === "wait" && live) {
    // a BLOCKED job only moves on a reply: its block now, rather than a wait that never ends
    if (!blocked.has(input.job)) await live.settles();
    return live.block();
  }
  if (input.action === "cancel" && live) {
    live.stop({ cap: "cancel", reason: "cancelled on request" });
    return live.done;
  }
  const dir = join(root, ".cheapag", "jobs", input.job);
  const record = readRecord(dir);
  if (!record) return failBlock(`job ${input.job} not found`);
  const block = () => readFileSync(join(dir, "result.txt"), "utf8").trimEnd();
  if (input.action === "show") return block();
  if (record.status === "RUNNING" || record.status === "BLOCKED") {
    return failBlock(`job ${input.job} is ${record.status} but not in this session (server pid ${record.pid ?? "unknown"}); ${input.action === "wait" ? "wait for" : "cancel"} it from the session that started it`);
  }
  if (input.action === "wait") return block(); // finished: its final block at once
  return failBlock(`job ${input.job} already finished (${record.status}); nothing to cancel`);
}

/** `jobs wait` on a batch: the next settlement of a live one, or a finished one's block (from its records) at once. */
function waitBatch(root: string, batch: string, progress: Progress): Promise<string> | string {
  const live = batches.get(batch);
  if (live) return live.look(true, progress);
  let record: BatchRecord;
  try {
    record = JSON.parse(readFileSync(join(root, ".cheapag", "batches", `${batch}.json`), "utf8"));
  } catch {
    return failBlock(`batch ${batch} not found`);
  }
  // shortcut: a batch another live session runs is shown as its records stand, not waited on; wait from that session
  const jobRecords = record.jobs.map((id) => readRecord(join(root, ".cheapag", "jobs", id)));
  if (jobRecords.some((r) => !r)) return failBlock(`batch ${batch}: a job record is missing (cleaned up?)`);
  return renderBatch(record, jobRecords as JobRecord[], record.fix ? readRecord(join(root, ".cheapag", "jobs", record.fix)) : undefined);
}

const LIST_MAX = 20;

type StoredRecord = JobRecord & {
  pid?: number; batch?: string | null; timing?: { startedAt?: string; endedAt?: string | null; blockedAt?: string }; baseline?: { tree?: string | null }; discarded?: boolean;
};

/** How long a BLOCKED job has waited for a reply, as a suffix for its one-line headline (jobs list, cheapag status). */
export const blockedFor = (r: StoredRecord) =>
  r.status === "BLOCKED" && r.timing?.blockedAt && r.pid && isAlive(r.pid) ? ` waiting=${Math.floor((Date.now() - Date.parse(r.timing.blockedAt)) / 60_000)}m` : "";

function readRecord(dir: string): StoredRecord | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  } catch {
    return undefined; // no record yet, or unreadable
  }
}

/** Every readable job record in the project, with the folder it lives in. */
export function records(root: string) {
  const base = join(root, ".cheapag", "jobs");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((id) => {
    const record = readRecord(join(base, id));
    return record ? [{ ...record, dir: join(base, id) }] : [];
  });
}

/**
 * Crash recovery at server start (spec: Job lifecycle, restart): a RUNNING or BLOCKED job whose server process is gone
 * becomes CANCELLED with `reason: server restart`; its worktree is kept.
 */
export function recoverJobs(cwd: string) {
  let root: string;
  try {
    root = projectRoot(cwd);
  } catch {
    return; // not a repository: no jobs
  }
  for (const { dir, ...record } of records(root)) {
    if (record.status !== "RUNNING" && record.status !== "BLOCKED") continue;
    // our own pid can only be a reused one: whoever wrote it is gone
    if (record.pid && record.pid !== process.pid && isAlive(record.pid)) continue;
    const cancelled = { ...record, status: "CANCELLED" as const, landed: false, reason: "server restart" };
    const text = renderJob(cancelled);
    writeWhole(join(dir, "result.json"), redact(JSON.stringify({ ...cancelled, blockTokensApprox: Math.ceil(text.length / 4) }, null, 2) + "\n"));
    writeWhole(join(dir, "result.txt"), redact(text + "\n"));
  }
}

/** Jobs other than `job` that landed since `since`: who changed a file under it meanwhile. */
function landedSince(root: string, job: string, since: Date) {
  // shortcut: a job landed later by `land apply` counts by when it ended, not when it landed; add a landedAt if that misleads
  return records(root).filter((r) => r.job !== job && r.landed && Date.parse(r.timing?.endedAt ?? "") >= since.getTime());
}

export type LandInput = { job: string; action: "apply" | "discard" };

/**
 * The `land` tool (spec: Tool contracts, A13): `apply` 3-way applies unlanded jobs' worktree changes to the working
 * tree under the lock, in the order given, stopping at the first that fails; `discard` deletes their worktrees. One line
 * per job. Records are updated (`landed`, `worktree`, `discarded`) so research's unlanded note and cleanup stay truthful.
 */
export async function landJobs(input: LandInput, ctx: WorkerContext): Promise<string> {
  const root = projectRoot(process.cwd());
  const ids = input.job.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return failBlock('land needs a job id, or several in landing order, e.g. "j7f3a,j7f3b"');
  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  const lines: string[] = [];
  let failed: string | undefined;
  for (const id of ids) {
    if (failed && input.action === "apply") {
      lines.push(`FAIL ${id} reason: not applied, since ${failed} before it did not land`);
      continue;
    }
    try {
      lines.push(await landOne(root, config, id, input.action));
    } catch (err) {
      lines.push(`FAIL ${id} reason: ${(err as Error).message}`);
      failed = id;
    }
  }
  // the last of a batch's groups landed or discarded: its integration check runs now
  const touched = new Set(ids.filter((id) => /^j[0-9a-z]{4}$/.test(id)).map((id) => readRecord(join(root, ".cheapag", "jobs", id))?.batch));
  for (const batch of touched) {
    const block = batch && (await integrateLater(root, config, batch, ctx));
    if (block) lines.push("", block);
  }
  return lines.join("\n");
}

/** A settled batch, still pending, with nothing left to land: runs its integration check and returns the batch block. */
async function integrateLater(root: string, config: Config, batch: string, ctx: WorkerContext) {
  const file = join(root, ".cheapag", "batches", `${batch}.json`);
  let record: BatchRecord & Integration & { plan: string; steps: string };
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // cleaned up
  }
  const cmd = config.integration_cmd ?? config.test_cmd;
  const jobRecords = record.jobs.map((id) => readRecord(join(root, ".cheapag", "jobs", id)));
  if (batches.has(batch) || !cmd || !jobRecords.every((r) => r) || !allLanded(jobRecords as JobRecord[])) return undefined;
  // claimed under the lock: two sessions landing a batch's last groups at once must not both run its check
  const claimed = await withLock(root, () => {
    const now = JSON.parse(readFileSync(file, "utf8")) as typeof record;
    if (now.integration !== "pending") return false;
    writeWhole(file, redact(JSON.stringify({ ...now, integration: "running" }, null, 2) + "\n"));
    return true;
  });
  if (!claimed) return undefined;
  record.verify ??= []; // a record from before integration checks
  let release: (() => void) | undefined;
  let fix: ReturnType<typeof runGroup> | undefined;
  const fixer = async (): Promise<Shared> => {
    const gate = consentGate(root, ctx.provider.provider);
    if ("block" in gate) throw new Error(`no consent for a fix job: ${gate.block.split("\n")[0]}`);
    const plan = parsePlan(readFileSync(join(root, record.plan), "utf8"));
    const opencode = await ctx.opencode(gate.route);
    release = holdOpencode();
    return { root, input: { plan: record.plan, steps: record.steps }, plan, config, route: gate.route, opencode, provider: ctx.provider, progress: ctx.progress };
  };
  try {
    await integrate(root, cmd, batch, record, jobRecords.map((r) => r!.landed), () => writeWhole(file, redact(JSON.stringify(record, null, 2) + "\n")), fixer, (run) => (fix = run));
  } finally {
    release?.();
  }
  return renderBatch(record, jobRecords as JobRecord[], fix?.record());
}

/** Applies or discards one finished, unlanded job; returns its OK line, or throws why not. */
async function landOne(root: string, config: Config, id: string, action: LandInput["action"]) {
  if (!/^j[0-9a-z]{4}$/.test(id)) throw new Error(`${id} is not a job id, e.g. j7f3a`); // the id becomes a path
  const dir = join(root, ".cheapag", "jobs", id);
  const record = readRecord(dir);
  if (!record) throw new Error(`job ${id} not found`);
  if (running.has(id)) throw new Error(`job ${id} is still ${record.status}; wait for it, or cancel it first`);
  if (record.status === "RUNNING" || record.status === "BLOCKED") throw new Error(`job ${id} is ${record.status} in another session (server pid ${record.pid ?? "unknown"})`);
  if (record.landed) throw new Error(`job ${id} already landed`);
  if (record.discarded) throw new Error(`job ${id} was already discarded`);
  // landing it now would put it ahead of its batch's later groups, out of step order
  if (record.batch && batches.has(record.batch)) throw new Error(`job ${id} belongs to batch ${record.batch}, still running; land it once the batch settles (jobs wait)`);
  const worktree = jobWorktree(root, id, record.baseline?.tree ?? "", config.link_dirs);
  if (!worktree) throw new Error(`job ${id} has no worktree left (cleaned up); nothing to ${action}`);
  const save = (update: Partial<StoredRecord>) => {
    const next = { ...record, ...update, worktree: null };
    const text = renderJob(next);
    writeWhole(join(dir, "result.json"), redact(JSON.stringify({ ...next, blockTokensApprox: Math.ceil(text.length / 4) }, null, 2) + "\n"));
    writeWhole(join(dir, "result.txt"), redact(text + "\n"));
  };
  if (action === "discard") {
    await releaseDirectory(worktree.path); // release before the worktree is removed
    removeWorktree(root, worktree); // dependency links are unlinked first
    save({ discarded: true });
    return `OK ${id} discarded`;
  }
  if (!record.baseline?.tree) throw new Error(`job ${id} has no recorded base (made by an older version); land it by hand from .cheapag/worktrees/${id}/`);
  const diff = worktreeDiff(worktree);
  // shortcut: two sessions applying the same job at once could both pass the checks above; the second 3-way apply then conflicts
  const clash = await land(root, id, diff.patch, diff.changed.map((c) => c.path));
  if (clash) {
    const files = conflictPaths(clash);
    throw new Error(`landing conflict${files.length ? ` in ${files.join(", ")}` : ""}, working tree untouched; discard it, or fix the overlap and delegate again`);
  }
  await releaseDirectory(worktree.path); // release before the worktree is removed
  removeWorktree(root, worktree);
  save({ landed: true, changed: diff.changed });
  const add = diff.changed.reduce((n, c) => n + c.add, 0);
  const del = diff.changed.reduce((n, c) => n + c.del, 0);
  return `OK ${id} applied files=${diff.changed.length} +${add}/-${del}`;
}

/** A job paused on a worker question. It lives only in this process, as does its paused session. */
export type BlockedJob = {
  job: string;
  questions: Question[];
  /** Answers the questions (one answer each) and resumes the session; resolves with the job's next block (final, or BLOCKED again). */
  resume: (answers: string[], progress: Progress) => Promise<string>;
};
type Progress = (turns: number, message: string) => void;
const blocked = new Map<string, BlockedJob>();

/** The jobs waiting for a reply right now, by job id (for the jobs tool and a batch's early return). */
export const blockedJobs = (): ReadonlyMap<string, BlockedJob> => blocked;

/** `reply`: a letter picks that option's label, anything else is passed through as free text (spec D8). */
export async function reply(input: { job: string; answer: string }, progress: Progress): Promise<string> {
  const entry = blocked.get(input.job);
  if (!entry) return failBlock(notWaiting(input.job));
  if (!input.answer.trim()) return failBlock("empty answer; reply with an option letter or free text"); // the job stays BLOCKED
  // one question also takes the numbered form ("1a", "1: text") that several questions need
  const numbered = /^\s*1\s*(?:[a-d]\)?\s*$|:)/i.test(input.answer);
  const answers = entry.questions.length === 1 && !numbered ? [pick(input.answer, entry.questions[0])] : answerEach(input.answer, entry.questions);
  if (typeof answers === "string") return failBlock(answers); // the job stays BLOCKED
  // in a batch, the same early return as delegate from here (spec: reply resolves like delegate): the first BLOCKED, or all settled
  const batch = batches.get(running.get(input.job)?.batch ?? "");
  const next = entry.resume(answers, batch ? batch.forward : progress);
  return batch ? batch.look(false, progress) : next;
}

/** A letter picks that option's label; anything else is free text. */
function pick(answer: string, question: Question) {
  const letter = answer.trim().toLowerCase().match(/^([a-d])\)?$/)?.[1];
  return (letter && question.options[letter.charCodeAt(0) - 97]) || answer;
}

/** Several questions take one answer each, "1a, 2b" or "1a, 2: free text" (commas allowed in free text); the error when any is left out. */
function answerEach(answer: string, questions: Question[]): string[] | string {
  const answers: string[] = [];
  for (const part of answer.split(/,(?=\s*\d+\s*(?:[a-d]\)?\s*(?:,|$)|:))/i)) {
    const m = part.trim().match(/^(\d+)\s*(?:([a-d])\)?|:\s*([\s\S]*\S))$/i);
    const n = Number(m?.[1]) - 1;
    const option = m?.[2] && questions[n]?.options[m[2].toLowerCase().charCodeAt(0) - 97];
    if (!m || !questions[n] || answers[n] !== undefined || (m[2] && !option)) return `cannot read "${part.trim()}" (or answered twice); answer each question as "1a, 2b" or "1a, 2: free text"`;
    answers[n] = option || m[3];
  }
  const missing = questions.map((_, i) => i + 1).filter((i) => !answers[i - 1]);
  return missing.length ? `unanswered: question ${missing.join(", ")}; answer each question as "1a, 2b" or "1a, 2: free text"` : answers;
}

/** Why `job` cannot take a reply, from its record on disk. */
function notWaiting(job: string) {
  const file = join(projectRoot(process.cwd()), ".cheapag", "jobs", job, "result.json");
  if (!/^j[0-9a-z]{4}$/.test(job) || !existsSync(file)) return `no job ${job}; reply only to a BLOCKED job's id`;
  const { status } = JSON.parse(readFileSync(file, "utf8")) as { status: string };
  return status === "BLOCKED"
    ? `job ${job} is no longer waiting for a reply (already answered, or its session ended); delegate the step again`
    : `job ${job} is ${status}, not BLOCKED; only a BLOCKED job takes a reply`;
}

/** A fresh `j` + 4 base36 id whose job folder does not exist yet. */
function newJob(root: string) {
  for (;;) {
    const job = newId("j");
    const dir = join(root, ".cheapag", "jobs", job);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    return { job, dir };
  }
}

/** `prefix` + 4 base36 chars: a job (`j`) or batch (`b`) id. */
const newId = (prefix: string) => `${prefix}${randomBytes(4).readUInt32BE().toString(36).slice(-4).padStart(4, "0")}`;

/**
 * The prompt after the agent's own rules (spec E2): the whole plan, then the current step(s), then the note.
 * shortcut: no repo map or CLAUDE.md/AGENTS.md excerpt yet; add them when worker quality needs the context.
 */
function contextPack(plan: Plan, steps: PlanStep[], note?: string, brief?: string, source?: string) {
  return [
    planText(plan),
    `>>> CURRENT STEP(S): ${steps.map((s) => s.id).join(", ")}\n\n${steps.map((s) => s.text).join("\n\n")}`,
    note && `Note: ${note}`,
    // start from what the scout found instead of re-exploring; an "unverified" repro is a lead, not a fact
    brief && `Scout brief (from research; start here, and check anything marked unverified):\n${brief}`,
    // the user's own words: the step is Claude's reading of them, and only the worker sees both (ticket 28)
    source && `Source (the user's request or the issue, verbatim; check the step against it and report disagreements in finish's disagree):\n${source}`,
  ].filter(Boolean).join("\n\n");
}

const planText = (plan: Plan) => [`# ${plan.title}`, plan.context, ...plan.steps.map((s) => s.text)].filter(Boolean).join("\n\n");

/** The integration fix job's prompt: the whole plan, then which landed steps fail the check together, and its error tail. */
function fixPrompt(plan: Plan, steps: PlanStep[], fix: { cmd: string; error: string[] }) {
  const ids = steps.map((s) => s.id).join(", ");
  return [
    planText(plan),
    `>>> INTEGRATION FIX: ${ids}`,
    `Steps ${ids} were done by separate jobs and have all landed in this code, but together they fail \`${fix.cmd}\`. ` +
      "Fix the cause so it passes, keeping every step's intent, then call finish.",
    fix.error.join("\n"),
  ].join("\n\n");
}

/** A redo diff longer than this is cut in its prompt. */
const MAX_REDO_PATCH = 50_000;

/** The redo's prompt to the same session: what clashed, where the conflict markers are, the step again and the original diff. */
function redoPrompt(steps: PlanStep[], files: string[], marked: string[], patch: string) {
  return [
    `>>> REDO STEP(S): ${steps.map((s) => s.id).join(", ")}`,
    `Your change could not land: the working tree changed meanwhile (${files.join(", ")}). This worktree was rebuilt from the current code, ` +
      `with your change applied again where it could be. Files where both changed the same lines hold <<<<<<< ======= >>>>>>> conflict markers: ` +
      `${marked.join(", ") || "none"}. Keep the current code's changes, redo the step's intent on top of them, leave no conflict markers, then call finish again.`,
    steps.map((s) => s.text).join("\n\n"),
    // shortcut: a huge diff is cut here; the worktree still holds the change wherever it applied
    `Your original change:\n\`\`\`diff\n${patch.length > MAX_REDO_PATCH ? `${patch.slice(0, MAX_REDO_PATCH)}\n… (cut)` : patch}\`\`\``,
  ].join("\n\n");
}

/** Keeps well-formed `path:start-end` ranges for files that exist under `base`, at most 5 (the server validates, not the worker). */
function reviewRanges(review: string[], base: string) {
  return review
    .map((r) => r.match(/^(.+):(\d+)(?:-(\d+))?$/))
    .filter((m): m is RegExpMatchArray => !!m && inside(base, join(base, m[1])) && existsSync(join(base, m[1])))
    .map((m) => ({ path: m[1], start: Number(m[2]), end: Number(m[3] ?? m[2]) }))
    .slice(0, 5);
}

const inside = (root: string, path: string) => {
  // normalised: relative() gives "..\\x" on Windows
  const rel = normalisePath(relative(root, path));
  return rel !== "" && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel);
};

/**
 * Writes a file whole: to a temporary name, then renamed into place. Records are rewritten on every turn while other
 * processes read them (`cheapag clean`, another session's `jobs list`); a half-written record must never be seen.
 */
function writeWhole(path: string, text: string) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}
