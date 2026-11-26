import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, isAbsolute, join, relative } from "node:path";
import { redact, type Provider } from "./credentials.js";
import { holdOpencode, type Opencode } from "./opencode.js";
import {
  needsOf,
  overlap,
  parsePlan,
  PLAN_FORMAT,
  selectGroups,
  type Group,
  type Plan,
  type PlanStep,
} from "./plan.js";
import {
  failBlock,
  permissionOptions,
  renderBatch,
  renderJob,
  type BatchRecord,
  type JobRecord,
  type PermissionBlock,
} from "./report.js";
import { addAllowCommand, loadConfig, type Config } from "./config.js";
import { projectScripts, workerRuleset } from "./permissions.js";
import { consentGate } from "./consent.js";
import {
  chain,
  DIFFICULTIES,
  escalationSkip,
  modelName,
  recordSpend,
  routeModels,
  runRouted,
  tierModel,
  usedBalance,
  type Difficulty,
  type Route,
} from "./routing.js";
import {
  checkAllows,
  envFailure,
  errorTail,
  runVerify,
  sameFailure,
  verifyCommands,
  type VerifyRun,
} from "./verify.js";
import {
  finishReport,
  openSession,
  releaseDirectory,
  type FinishReport,
  type PermissionAnswer,
  type PermissionAsk,
  type Question,
  type RunResult,
  type Session,
} from "./worker.js";
import {
  callRoot,
  conflictPaths,
  createWorktree,
  git,
  hasCommits,
  jobWorktree,
  land,
  leftoverMarkers,
  operationInProgress,
  projectRoot,
  reapply,
  removeWorktree,
  withLock,
  worktreeDiff,
  type Changed,
  type Worktree,
} from "./workspace.js";
import { isAlive, normalisePath } from "./platform.js";
import { toolTarget } from "./watch.js";

/** Jobs: runs each group of plan steps as one job, start to landing, under per-job caps (several groups make a batch); lists, shows and cancels jobs. */

/**
 * The worker session's ruleset for this job. The step's own done-when checks are allowed exactly as written, so the
 * worker can check its work before finishing (Cheap Agent runs them anyway); the hard denylist still comes last.
 */
function rulesetFor(worktree: Worktree, cmds: string[], config: Config) {
  const { scripts, exact } = projectScripts(worktree.path);
  return workerRuleset({
    scripts,
    exact: [...exact, ...cmds.flatMap(checkAllows)],
    allowCommands: config.allow_commands,
    linked: worktree.linked,
    onBlockedCommand: config.on_blocked_command,
  });
}

/** More rejections than this in one job earn a risk line. */
const MAX_QUIET_REJECTIONS = 5;

/** A harder step earns proportionally more turns before its cap (defaults 25/50/75 for easy/medium/hard). */
const TURN_SCALE: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };
/** The turn cap for the escalation attempt after a turn-cap stop: its own, smaller budget. */
const ESCALATION_TURNS = 15;
/** Fail fast applies only to fixes: a step or source naming any of these is a bug to reproduce first. */
const FIX_WORDS =
  /\b(bug|fix(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|error|crash(?:es|ed)?|regress(?:ion|ed)?|broken|incorrect|wrong|traceback|exception)\b/i;

/**
 * `brief`: a research scout brief (ticket 23.4), resolved to its text, handed to every worker of the delegation.
 * `source`: the user's request or the issue, verbatim (ticket 28), so the worker can check the step against it.
 */
export type DelegateInput = {
  plan: string;
  steps: string;
  note?: string;
  wait?: boolean;
  brief?: string;
  source?: string;
  difficulty?: Difficulty;
  model?: string;
};
/** What the tool takes: a plan file and steps, or (one step, no plan file) an inline task with optional files and done-when. */
export type DelegateRequest = Partial<DelegateInput> & {
  task?: string;
  files?: string;
  done_when?: string;
  root?: string;
};

/** A job id: the only thing that may become a job folder's name. */
const JOB_ID = /^j[0-9a-z]{4}$/;
/** A job's (or research call's) log folder, and a batch's record file. */
const jobDir = (root: string, id: string) => join(root, ".cheapag", "jobs", id);
const batchFile = (root: string, batch: string) =>
  join(root, ".cheapag", "batches", `${batch}.json`);

/** An allowed model by full `provider/id` or bare id. */
const pickModel = (route: Route, name?: string) =>
  name ? routeModels(route).find((m) => modelName(m) === name || m.id === name) : undefined;

/** A brief longer than this is cut in the worker's prompt. */
const MAX_BRIEF = 6_000;

/** A source longer than this is cut in the worker's prompt (the issue's head is what matters; comment threads trail). */
const MAX_SOURCE = 8000;

/** `source=`: the text itself, or a repo-relative file holding it (the benchmark writes the issue to one; a user may point at a ticket export). */
function resolveSource(root: string, source: string | undefined): string | undefined {
  const value = source?.trim();
  if (!value) return undefined;
  const file = join(root, value);
  const text =
    !value.includes("\n") && value.length < 512 && !isAbsolute(value) && existsSync(file)
      ? readFileSync(file, "utf8").trim()
      : value;
  return text.length > MAX_SOURCE
    ? `${text.slice(0, MAX_SOURCE)}\n[… cut at ${MAX_SOURCE} characters]`
    : text;
}

/** `brief=`: a research id (its block from the log) or the brief's text itself. */
function resolveBrief(
  root: string,
  brief: string | undefined,
): { text?: string } | { fail: string } {
  const value = brief?.trim();
  if (!value) return {};
  if (!/^r[0-9a-z]{4}$/.test(value)) return { text: value.slice(0, MAX_BRIEF) };
  const file = join(jobDir(root, value), "result.txt");
  if (!existsSync(file))
    return {
      fail: `brief ${value}: no research with that id (cleaned up?); pass the brief's text instead`,
    };
  return { text: readFileSync(file, "utf8").trim().slice(0, MAX_BRIEF) };
}

/**
 * An inline task becomes a one-step plan under .cheapag/plans/ so everything downstream (records, integration checks,
 * re-delegation) sees an ordinary plan file. Without done_when, verification falls back to the repo's test_cmd.
 * shortcut: these plan files are never cleaned up; fold them into the job-log retention if they pile up.
 */
function inlinePlan(root: string, req: DelegateRequest): { plan: string } | { fail: string } {
  const task = req.task!.trim();
  if (!task)
    return { fail: "task is empty: say what to change, in which files, and how to check it" };
  if (req.plan || req.steps) return { fail: "give either task, or plan and steps, not both" };
  const indent = (text: string) =>
    text
      .split(/\r?\n/)
      .map((l, i) => (i ? "  " + l : l))
      .join("\n");
  const title = task.split(/\r?\n/)[0].slice(0, 70);
  const body = [
    `# ${title}`,
    "",
    "## 1 task",
    `files: ${req.files?.trim() || "./"}`,
    `do: ${indent(task)}`,
    `done-when: ${indent(req.done_when?.trim() || "the change described in do: is made and the existing tests still pass")}`,
    "",
  ].join("\n");
  const rel = join(
    ".cheapag",
    "plans",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}.md`,
  );
  mkdirSync(join(root, ".cheapag", "plans"), { recursive: true });
  writeFileSync(join(root, rel), body);
  return { plan: rel };
}

/** What a tool call that may start workers gets from the server. */
export type WorkerContext = {
  provider: Provider;
  opencode: (route: Route) => Promise<Opencode>;
  progress: Progress;
};

export async function delegate(req: DelegateRequest, ctx: WorkerContext): Promise<string> {
  const root = callRoot(req.root);
  // first: an unapproved repo gets CONSENT before any job, worktree, OpenCode boot or provider call
  const gate = consentGate(root, ctx.provider.provider);
  if ("block" in gate) return gate.block;
  const { route } = gate;
  const resolved = delegateInput(root, req);
  if ("fail" in resolved) return failBlock(resolved.fail);
  const { input } = resolved;
  // only the caller's path: an inline task's own plan lives under .cheapag/plans/
  if (
    req.task === undefined &&
    input.plan.split(/[\\/]/).filter((p) => p && p !== ".")[0] === ".cheapag"
  )
    return failBlock(
      `plan ${input.plan} is under .cheapag/, Cheap Agent's state folder, which workers cannot see; save plans under .plan/`,
    );
  if (input.model && !pickModel(route, input.model))
    return failBlock(
      `model ${input.model} is not allowed here; allowed: ${routeModels(route)
        .map((m) => m.id)
        .join(", ")}; run /cheapag:allow to add it`,
    );
  const read = readPlan(root, input);
  if ("fail" in read) return failBlock(read.fail);
  const { plan, groups } = read;

  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  if (!hasCommits(root))
    return failBlock(
      `this repository has no commits yet, and Cheap Agent starts each job from the last commit. Make a first commit, then delegate again: git add -A && git commit -m "start"`,
    );
  const busy = operationInProgress(root);
  if (busy)
    return failBlock(`${busy} in the working tree; finish or abort it, then delegate again`);

  // one boot with one route for every group: a config change would restart OpenCode under the batch's running jobs
  const opencode = await ctx.opencode(route);
  const release = holdOpencode();
  const shared = {
    root,
    input,
    plan,
    config,
    route,
    opencode,
    provider: ctx.provider,
    progress: ctx.progress,
  };
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

/** The call's input: an inline task as a one-step plan, or the caller's plan and steps; or why neither. */
function delegateInput(
  root: string,
  req: DelegateRequest,
): { input: DelegateInput } | { fail: string } {
  const brief = resolveBrief(root, req.brief);
  if ("fail" in brief) return brief;
  const source = resolveSource(root, req.source);
  const rest = {
    note: req.note,
    wait: req.wait,
    brief: brief.text,
    source,
    difficulty: req.difficulty,
    model: req.model,
  };
  if (req.task !== undefined) {
    const made = inlinePlan(root, req);
    if ("fail" in made) return made;
    return { input: { plan: made.plan, steps: "1", ...rest } };
  }
  if (req.plan && req.steps) return { input: { plan: req.plan, steps: req.steps, ...rest } };
  return { fail: "give task (what to change, files, how to check), or plan and steps" };
}

/** Reads and parses the input's plan file and selects the groups of steps to run; or why it cannot. */
function readPlan(
  root: string,
  input: DelegateInput,
): { plan: Plan; groups: Group[] } | { fail: string } {
  const planFile = join(root, input.plan);
  if (isAbsolute(input.plan) || !inside(root, planFile))
    return {
      fail: `plan ${input.plan} must be a path inside the repository, relative to its root`,
    };
  if (!existsSync(planFile)) return { fail: `plan ${input.plan} not found` };
  let plan: Plan;
  try {
    plan = parsePlan(readFileSync(planFile, "utf8"));
  } catch (err) {
    return { fail: `plan ${input.plan}: ${(err as Error).message}\n${PLAN_FORMAT}` };
  }
  try {
    return { plan, groups: selectGroups(plan, input.steps) };
  } catch (err) {
    return { fail: `plan ${input.plan}: ${(err as Error).message}` };
  }
}

type Shared = {
  root: string;
  input: DelegateInput;
  plan: Plan;
  config: Config;
  route: Route;
  opencode: Opencode;
  provider: Provider;
  progress: Progress;
};

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
  const cmds = g.fix
    ? [g.fix.cmd]
    : verifyCommands(
        steps.map((s) => s.fields["done-when"]),
        config.test_cmd,
      );
  const { job, dir } = newJob(root);
  const write = (name: string, value: unknown) =>
    typeof value === "string"
      ? writeWhole(join(dir, name), redact(value))
      : writeJson(join(dir, name), value);
  const stepIds = g.group.label;
  // a step's own difficulty: wins over the call's; in a range the hardest step decides
  const difficulty =
    [...DIFFICULTIES].reverse().find((d) => steps.some((s) => s.fields.difficulty === d)) ??
    input.difficulty;
  const model = pickModel(route, input.model) ?? tierModel(route, difficulty);
  // against the implement model, so a tier model shows as model= in the headline
  const requested = modelName(route.implement);
  const startedAt = new Date();
  write("request.json", {
    ...input,
    steps: stepIds,
    batch: g.batch,
    model: modelName(model),
    difficulty,
    startedAt,
  });
  const elapsed = () => Math.round((Date.now() - startedAt.getTime()) / 1000);

  const escalation = route.escalation;
  // the job's model, then its allowed fallbacks: a provider limit moves the session on to the next one
  const models = chain(
    model,
    route.fallbacks.filter((m) => modelName(m) !== modelName(model)),
  );
  let billing: JobRecord["billing"];
  let cleanupError: string | undefined;
  /**
   * Removes a landed job's worktree. The change is already in the working tree, so a failure here (Windows refusing to
   * delete a folder something still holds open) is recorded on the job, never turned into a FAIL.
   */
  const cleanUp = async (tree: Worktree) => {
    try {
      await dropWorktree(root, tree);
    } catch (err) {
      cleanupError = (err as Error).message;
    }
  };
  // whoever is waiting on this job right now: delegate first, then each reply
  let progress = g.progress;
  // the same line goes to progress.txt for anything watching the folder; best effort, with or without an MCP progress token
  const tell: Progress = (turns, message) => {
    try {
      writeWhole(join(dir, "progress.txt"), message + "\n");
    } catch {
      /* never break the job */
    }
    progress(turns, message);
  };
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
  let asked: Asked[] | null = null;
  let pending: PermissionBlock | null = null; // the command permission ask this job is paused on
  let blockedAt: Date | undefined;
  let expiry: NodeJS.Timeout | undefined; // max_blocked_minutes, while BLOCKED
  let worktree: Worktree | undefined;
  let session: Session | undefined;
  let report: FinishReport = finishReport({ text: "" });
  let changed: Changed[] = [];
  let reason: string | undefined;
  const verified: VerifyRun[] = [];
  const tried: string[] = [];
  let found: string | undefined; // a stopped worker's findings note
  let selfFix = 0;
  let escalated = false;
  let repro: JobRecord["repro"]; // the server's check of the worker's reproduction test (OK jobs only)
  let reproRisk: string | undefined;
  let failing: Failing | undefined;
  let checked = false; // whether verify has seen the worker's latest changes
  let redone = 0; // 1 once a landing conflict started the redo (spec: Landing and redo)
  let conflict: string[] | undefined; // set when the redo could not land either: the job is CONFLICT

  // caps count across the whole job; any stop aborts the session, and all but the turn cap also kill verify
  const { limits } = config;
  // the turn cap scales with the step's difficulty, and the escalation attempt gets its own smaller one
  const scale = TURN_SCALE[difficulty ?? "easy"];
  let turnCap = limits.max_turns * scale;
  let turnBase = 0; // turns already spent when the current turn budget began (reset for the escalation attempt)
  const escalationCap = Math.min(limits.max_turns, ESCALATION_TURNS);
  const halt = new AbortController(); // the worker session
  const kill = new AbortController(); // verify processes: a turn cap still runs one last check, so PARTIAL never hides failing tests
  let escalationTurn: AbortController | undefined; // the escalation attempt's own run, when it follows a turn-cap stop
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
    else escalationTurn?.abort(); // a turn cap during the escalation attempt ends that run too (it runs after `halt` aborted)
  };
  const overCost = () => {
    if (session && session.totals().usage.costUsd >= limits.max_cost_usd)
      stop({ cap: "cost", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
  };
  const overTurns = () => {
    if (session && session.totals().turns - turnBase >= turnCap)
      stop({ cap: "turns", reason: `turn cap (${turnCap}) reached` });
  };
  // fail fast: a step with checks that has edited nothing by repro_by_turns stops now, so Claude takes over
  // without a 40-turn failed job in its context; any edit, source or test, lifts the stop and the job runs to its normal cap
  // only a fix has a bug to reproduce; a feature step is never stopped for lacking a test
  const kind = steps.find((s) => s.fields.kind)?.fields.kind;
  const isFix =
    g.fix ||
    (kind
      ? kind === "fix"
      : FIX_WORDS.test(
          [...steps.map((s) => `${s.title} ${s.fields.do ?? ""}`), input.source ?? ""].join("\n"),
        ));
  let edited = false;
  let carried = new Set<string>(); // paths already dirty when the worktree opened (carried over from the repo): not the worker's edits
  const dirty = () =>
    git(worktree!.path, ["status", "--porcelain"])
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  const reproDue = () => {
    if (edited || !isFix || !cmds.length || !worktree || !session) return;
    const by = limits.repro_by_turns * scale;
    if (session.totals().turns < by) return;
    edited = dirty().some((f) => !carried.has(f));
    if (!edited)
      stop({
        cap: "turns",
        reason: `nothing edited by turn ${by}; the worker was still exploring`,
      });
  };
  // the minute cap counts working time only: the clock is paused while the job waits BLOCKED on a reply
  let clockLeft = limits.max_minutes * 60_000;
  let clockStarted = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const startClock = () => {
    clockStarted = Date.now();
    timer = setTimeout(
      () => stop({ cap: "minutes", reason: `minute cap (${limits.max_minutes} min) reached` }),
      clockLeft,
    );
  };
  const pauseClock = () => {
    if (timer === undefined) return; // not started yet, or already paused: never count the same stretch twice
    clearTimeout(timer);
    timer = undefined;
    clockLeft -= Date.now() - clockStarted;
  };
  let finished!: (text: string) => void;
  const done = new Promise<string>((resolve) => (finished = resolve));
  const halted = new Promise<void>((resolve) =>
    halt.signal.aborted
      ? resolve()
      : halt.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  let parked = false; // finished, waiting for earlier groups to land: it can only move once they settle
  running.set(job, {
    root,
    stop,
    done,
    batch: g.batch,
    settles: () => settled,
    block: () => renderJob(last),
    parked: () => parked,
  });

  /** Runs the done conditions in the worktree; returns the failing run and its error tail, if any. */
  const verify = async () => {
    const runs = await runVerify(
      worktree!.path,
      cmds,
      (cmd) =>
        tell(session!.totals().turns, `step ${g.group.label} · verify ${cmd} · ${elapsed()}s`),
      kill.signal,
    );
    checked = true;
    verified.push(...runs);
    // the full output stays on disk; Claude only ever sees the tail
    for (const r of runs)
      appendFileSync(
        join(dir, "verify.log"),
        redact(`$ ${r.cmd}\n${r.output}\n(exit ${r.ok ? "ok" : "failed"}, ${r.ms} ms)\n\n`),
      );
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
    const risks = jobRisks(reproRisk, report, rejections);
    const record = {
      format: "cheapag/1" as const,
      job,
      batch: g.batch,
      kind: g.fix ? "fix" : "implement",
      status,
      landed,
      plan: input.plan,
      steps: stepIds,
      provider: g.provider.provider,
      // the server process running the job: a restart finds RUNNING/BLOCKED records whose pid is gone
      pid: process.pid,
      models: {
        requested,
        final: modelName(escalated ? escalation! : models.current),
        escalated,
        fallbacks: models.used,
      },
      difficulty,
      billing,
      baseline: baselineOf(worktree),
      worktree: unlandedWorktree(root, worktree, landed),
      cleanupError,
      sessionID: session?.sessionID ?? null,
      tests: silent ? undefined : testsResult(verified.length > 0, failing),
      ...failureFields(failing),
      tried,
      ...(found && { found }),
      summary: silent ? "" : report.summary,
      changed,
      risks: silent ? [] : risks,
      ...testFileField(changed),
      // a landed job's files are in the working tree; an unlanded one's only in its worktree
      review: reviewRanges(report.review, landed || !worktree ? root : worktree.path),
      missing: missingLines(status, report.missing, stopped),
      reason,
      conflict,
      verify: verified.map(({ cmd, ok, ms }) => ({ cmd, ok, ms })),
      selfFix,
      redo: redone,
      ...(repro && { repro }),
      ...questionFields(asked, pending),
      autoRejected: rejections,
      usage: usageOf(session),
      timing: timingOf(startedAt, status, blockedAt),
    };
    last = record;
    return saveRecord(dir, record);
  };

  /** The worker asked: the job is BLOCKED, its block goes to whoever waits, and the session stays paused until `reply` resumes it. */
  const onQuestion = (questions: Question[], permission = false, always = true) =>
    new Promise<string[]>((answer) => {
      pauseClock();
      asked = questions.map((q) => ({ text: q.question, options: q.options, answer: null }));
      changed = worktreeDiff(worktree!).changed;
      blockedAt = new Date();
      // a forgotten question must not hold the session, the worktree and a worker slot forever
      expiry = setTimeout(
        () => stop({ cap: "cancel", reason: `no reply within ${limits.max_blocked_minutes} min` }),
        limits.max_blocked_minutes * 60_000,
      ).unref();
      blocked.set(job, {
        job,
        root,
        questions,
        permission,
        always,
        resume: (answers, replyProgress) => {
          clearTimeout(expiry);
          blockedAt = undefined;
          blocked.delete(job);
          startClock();
          progress = replyProgress;
          asked = questions.map((q, i) => ({
            text: q.question,
            options: q.options,
            answer: answers[i],
          }));
          const after = nextOutcome();
          answer(answers);
          finalize("RUNNING"); // a batch block shown before its next turn must not repeat the answered question
          return after;
        },
      });
      announce(finalize("BLOCKED"));
    });

  /** A bash command off the allow list: the same pause as a question, with three fixed options; "always" is saved by the server, never the worker. */
  const onPermission = async (ask: PermissionAsk): Promise<PermissionAnswer> => {
    pending = {
      title: ask.title,
      command: ask.command,
      why: ask.why,
      prefix: ask.prefix,
      always: ask.always,
    };
    const options = permissionOptions(ask.prefix);
    const [label] = await onQuestion([{ question: ask.title, options }], true, ask.always);
    pending = null;
    const choice = options.indexOf(label);
    if (choice === 1) addAllowCommand(root, ask.prefix);
    return permissionAnswer(choice);
  };

  /**
   * Its patch clashed with the working tree on landing (spec: Landing and redo): the tree is untouched, and one redo
   * applies the change again onto a fresh worktree of the current state, then takes the normal path in the same
   * session (same job, so caps and usage carry on). It lands OK with redo=1, or sets `conflict`: the files, and the jobs
   * that changed them meanwhile. Called where the job lands, so a batch's landing order holds.
   */
  const redo = async (
    patch: string,
    clash: string,
    work: (prompt: string, tag: string) => Promise<RunResult>,
  ) => {
    redone = 1;
    write("conflict.patch", patch); // log copy of the change that clashed
    await dropWorktree(root, worktree!); // then recreated
    // the same path, so the session's directory stays valid
    worktree = createWorktree(root, job, config.link_dirs);
    const marked = reapply(worktree, patch);
    const files = clashFiles(marked, conflictPaths(clash), changed);
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
    let why = redoFailure({ result, failing, worktree, changed: diff.changed });
    if (!why) {
      landing = true;
      pauseClock();
      if (
        !(await land(
          root,
          job,
          diff.patch,
          diff.changed.map((c) => c.path),
        ))
      ) {
        await cleanUp(worktree);
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

  /** Waits for the job's turn (a batch's scheduling), then opens its worktree and the worker session. */
  const begin = async () => {
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
      step: { label: g.group.label, title: steps.map((s) => s.title).join("; ") },
      // nobody watches a fix job for a BLOCKED block: its questions are rejected (with a risk line)
      onQuestion: g.fix ? undefined : (q) => onQuestion(q),
      onPermission: g.fix ? undefined : onPermission,
      signal: halt.signal,
      onEvent: (event, turns) => {
        appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
        // one progress notification per worker turn; finer events (deltas, usage) would only be noise in /tasks
        if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
          const part = event.properties.part;
          if (part.state.status === "completed" || part.state.status === "error") {
            const target = toolTarget(part.tool, part.state.input, worktree?.path ?? "");
            tell(
              turns,
              `step ${g.group.label} · turn ${turns} · ${part.tool}${target ? " " + target : ""} · ${elapsed()}s`,
            );
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
  };

  const provider = g.provider.provider;
  // a provider limit is not a cap: the worker aborts the session itself and the job falls back, or stops as BUDGET;
  // a transient provider error retries, falls back the same way, then stops as PROVIDER
  const routed = async (text: string, on?: typeof escalation, interrupt?: AbortSignal) => {
    const r = await runRouted(session!, text, models, provider, on, interrupt);
    if (r.budget) stopped ??= { cap: "provider", reason: r.budget };
    if (r.provider) stopped ??= { cap: "down", reason: r.provider };
    return r;
  };

  /** Whether another attempt may run on the failing check; when not, says why in tried: where that helps. */
  const mayAttempt = (attempt: Attempt, tag: string, failure: Failing) => {
    // the check could not run (missing tool, broken Node): no edit fixes that, so fixes and the escalation would only burn turns
    const env = envFailure(failure.run);
    if (env) {
      tried.push(`${tag}env: the check could not run (${env})`);
      return false;
    }
    overTurns(); // a fix needs at least one more turn
    if (stopped as Stop | undefined) return false; // a cap, cancel or provider budget (cast: set from callbacks, keep TS from narrowing)
    const esc = attempt === "esc";
    if (esc && escalated) return false; // already used for the turn-cap hand-over
    const skip =
      esc && escalationSkip(escalation, models, config.escalation_skip_at, session!.totals().spend);
    if (skip) {
      tried.push(tag + skip);
      return false;
    }
    return true;
  };

  /** One self-fix, or the escalation on the stronger model, against the failing check; `done` when no attempt follows it. */
  const attemptFix = async (attempt: Attempt, tag: string, failure: Failing) => {
    const esc = attempt === "esc";
    if (esc) escalated = true;
    else selfFix++;
    const before: string[] = failure.tail;
    const result = await routed(fixThis(before), esc ? escalation : undefined);
    checked = false;
    const fresh = ownReport(result);
    if (fresh) report = fresh;
    const label = attemptLabel(`${tag}${attempt}`, fresh);
    if (result.limit && esc) {
      tried.push(`${label} → usage limit: ${result.limit.message.slice(0, 80)}`);
      escalated = false; // it never ran: the job ends on the implement chain's model and result
      return { result, done: true };
    }
    if (result.error) {
      tried.push(`${label} → ${stopped ? `stopped: ${stopped.reason}` : "worker error"}`);
      return { result, done: true };
    }
    failing = await verify();
    tried.push(`${label} → ${verdict(before, failing)}`);
    return { result, done: false };
  };

  /** One prompt through the normal path: the run, then verify with up to 2 self-fixes and 1 escalation. `tag` prefixes tried: lines. */
  const work = async (prompt: string, tag = "") => {
    // no hand-over at the turn cap: it rescued nothing in the model bake-off and doubled a failed job's length
    let result = await routed(prompt);
    report = finishReport(result);
    failing = undefined;
    checked = false;
    if (!result.error && cmds.length) {
      failing = await verify();
      // up to 2 self-fixes in the same session, then 1 escalation on the stronger model (spec: Job lifecycle)
      for (const attempt of ATTEMPTS) {
        if (!failing || !mayAttempt(attempt, tag, failing)) break;
        const round = await attemptFix(attempt, tag, failing);
        result = round.result;
        if (round.done) break;
      }
    }
    // stopped mid-change by the turn cap: check what the worker left, to tell PARTIAL from FAIL
    if (stopped?.cap === "turns" && cmds.length && !checked) failing = await verify();
    return result;
  };

  /** The worker's first prompt: the integration fix's, or the plan and its step(s) with any repo path pointed at the worktree. */
  const firstPrompt = () => {
    // an absolute repo path typed in a task would point the worker outside its worktree
    const rootRe = new RegExp(
      [...new Set([root, realpathSync(root)])]
        .map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    ); // one pass: the worktree path contains the root
    const inWorktree = (text: string) => text.replace(rootRe, () => worktree!.path);
    return g.fix
      ? fixPrompt(plan, steps, g.fix)
      : inWorktree(contextPack(plan, steps, input.note, input.brief, input.source));
  };

  /**
   * A turn cap during verify or the fixes does not lose the escalation: with a diff and a failing check it still runs
   * once on the escalation model, on its own smaller budget; a cap reached here ends the job as before. Returns the
   * escalation's result, or `result` when it does not run.
   */
  const escalateAfterTurnCap = async (result: RunResult) => {
    const escalationBlocked =
      escalated || !failing || envFailure(failing.run) || !cmds.length || !worktree || !session
        ? "not now"
        : escalationSkip(escalation, models, config.escalation_skip_at, session.totals().spend);
    if (stopped?.cap !== "turns" || escalationBlocked || !worktreeDiff(worktree!).changed.length)
      return result;
    escalated = true;
    turnBase = session!.totals().turns;
    turnCap = escalationCap;
    escalationTurn = new AbortController();
    stopped = undefined; // the escalation replaces the turn-cap stop
    const before = failing!.tail;
    const escalationResult = await session!.run(
      fixThis(before),
      escalation,
      escalationTurn.signal,
      true,
    );
    const fresh = ownReport(escalationResult);
    if (fresh) report = fresh;
    write("finish.json", report);
    const label = attemptLabel("esc", fresh);
    if (escalationResult.error || escalationResult.interrupted) {
      tried.push(`${label} → ${escalationEnd(stopped as Stop | undefined, escalationResult)}`);
    } else {
      failing = await verify();
      tried.push(`${label} → ${verdict(before, failing)}`);
    }
    return escalationResult;
  };

  /** Lands a job that finished with passing checks, after checking a fix's reproduction; otherwise records why not. */
  const conclude = async (result: RunResult, diff: { patch: string; changed: Changed[] }) => {
    if (stopped) return; // a capped or cancelled job never lands; its worktree is kept
    if (result.error) {
      reason = `worker error: ${result.error}`;
      return;
    }
    if (failing) return; // a verify failure is explained by the error: and tried: sections, not a reason
    // only a fix has a reproduction to check: a feature lands without the without-the-change run
    if (isFix)
      ({ repro, risk: reproRisk } = await checkRepro(
        worktree!,
        report.repro,
        [...cmds, ...(config.test_cmd ? [config.test_cmd] : []), ...config.allow_commands],
        verified.filter((r) => r.ok).map((r) => r.cmd),
        diff.changed.map((c) => c.path),
        kill.signal,
      ));
    // waiting for earlier groups to land is still cancellable; the clock is paused, since an earlier group may sit BLOCKED for long
    pauseClock();
    parked = true;
    await Promise.race([g.beforeLand?.(), halted]);
    parked = false;
    if (stopped as Stop | undefined) return;
    landing = true; // from here on, caps and cancel no longer apply (until a redo works again)
    pauseClock();
    const clash = await land(
      root,
      job,
      diff.patch,
      diff.changed.map((c) => c.path),
    );
    if (!clash) await cleanUp(worktree!);
    else await redo(diff.patch, clash, work);
  };

  /** Adds the session's spend to the user-wide ledger: Go windows are per account, so it decides later escalations and shows balance use. */
  const recordSessionSpend = () => {
    if (!session) return;
    try {
      recordSpend(session.totals().spend);
      if (g.provider.provider === "opencode-go" && usedBalance(session.totals().spend))
        billing = "zen";
    } catch {
      // the ledger only steers later escalations: a write error (full disk, permissions) must not change this job's result
    }
  };

  finalize("RUNNING");
  // the job outlives this call when it blocks: it settles each outcome in turn (BLOCKED, then whatever follows a reply)
  void (async () => {
    try {
      await begin();
      let result = await work(firstPrompt());
      write("finish.json", report);
      result = await escalateAfterTurnCap(result);
      const diff = worktreeDiff(worktree!);
      changed = diff.changed;
      write("diff.patch", diff.patch); // the log copy is redacted; landing applies the in-memory patch
      // a capped worker leaves Claude what it learned, so the take-over does not re-read the same files (after the diff, so the note turn cannot change the result)
      const cap = (stopped as Stop | undefined)?.cap;
      if (cap === "turns" || cap === "minutes" || cap === "cost") found = await findings(session!);
      await conclude(result, diff);
    } catch (err) {
      reason = (err as Error).message;
    }
    clearTimeout(timer);
    running.delete(job);
    blocked.delete(job);
    recordSessionSpend();
    let status: JobRecord["status"] = !stopped && reason === undefined && !failing ? "OK" : "FAIL";
    if (stopped) {
      // the cap or cancel explains the stop, not the aborted prompt's error
      reason = stopped.reason;
      status = stoppedStatus(stopped, changed.length > 0 && !failing);
      if (status === "PARTIAL") reason = undefined; // spec D5: PARTIAL says it through missing:
    } else if (conflict) status = "CONFLICT";
    const text = finalize(status);
    if (status === "OK") gzipEvents(dir);
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

/** A failing check's run, and the error tail Claude sees. */
type Failing = { run: VerifyRun; tail: string[] };

/** The job's risks: the server's own first, so the 5-risk cap never cuts them, then the worker's. */
function jobRisks(reproRisk: string | undefined, report: FinishReport, rejections: unknown[]) {
  return [
    ...(reproRisk ? [reproRisk] : []),
    ...(report.disagree && !/^none\b/i.test(report.disagree)
      ? [`spec vs source: ${report.disagree}`]
      : []),
    ...(rejections.length > MAX_QUIET_REJECTIONS
      ? [
          `${rejections.length} tool calls or permission requests were rejected; check the worker stayed in scope (see the log)`,
        ]
      : []),
    ...report.risks,
  ];
}

/** Where the worktree came from; `tree` is what its diff is measured against, so `land apply` can land it later. */
function baselineOf(worktree: Worktree | undefined) {
  return {
    head: worktree?.head ?? null,
    stash: worktree?.stash ?? null,
    tree: worktree?.base ?? null,
  };
}

/** An unlanded job's worktree, repo-relative; null once landed or before it has one. */
function unlandedWorktree(root: string, worktree: Worktree | undefined, landed: boolean) {
  return !landed && worktree ? normalisePath(relative(root, worktree.path)) : null;
}

/** Server-measured: "none" when nothing ran (no conditions, or the worker failed before verify). */
function testsResult(ran: boolean, failing: Failing | undefined): JobRecord["tests"] {
  if (!ran) return "none";
  return failing ? "fail" : "pass";
}

/** A failing check's error: lines; a check that could not run at all (missing tool, broken Node) leads with that and sets check=env, since it is not bad code. */
function failureFields(failing: Failing | undefined) {
  if (!failing) return { error: undefined };
  const env = envFailure(failing.run);
  return {
    error: env ? [env, ...failing.tail] : failing.tail,
    ...(env && { check: "env" as const }),
  };
}

/** The record's test= field: the first changed file that is a test, if any. */
function testFileField(changed: Changed[]) {
  const testFile = changed.find((c) => TEST_FILE.test(c.path));
  return testFile ? { test: testFile.path } : {};
}

/** A PARTIAL job's missing: lines when the worker gave none, since a worker stopped by a cap rarely says what it left undone. */
function missingLines(status: JobRecord["status"], missing: string[], stop: Stop | undefined) {
  if (status !== "PARTIAL" || missing.length) return missing;
  return [`unknown: stopped (${stop?.reason ?? "cap"}); compare the diff with the step`];
}

/** The record's question fields: one question, the command permission ask it waits on, or several questions. */
function questionFields(asked: Asked[] | null, pending: PermissionBlock | null) {
  return {
    question: asked?.length === 1 ? asked[0] : null,
    ...(pending && { permission: pending }),
    ...(asked && asked.length > 1 && { questions: asked }),
  };
}

/** The session's usage so far; zero before it opened. */
function usageOf(session: Session | undefined) {
  return {
    turns: session?.totals().turns ?? 0,
    calls: session?.totals().calls ?? 0,
    ...(session?.totals().usage ?? { costUsd: 0 }),
  };
}

/** The record's timing: a RUNNING or BLOCKED job has not ended, and a BLOCKED one says since when it waits. */
function timingOf(startedAt: Date, status: JobRecord["status"], blockedAt: Date | undefined) {
  const waiting = status === "BLOCKED";
  return {
    startedAt,
    endedAt: status === "RUNNING" || waiting ? null : new Date(),
    ms: Date.now() - startedAt.getTime(),
    ...(waiting && { blockedAt }),
  };
}

/** Compresses a settled job's (or research call's) events.jsonl; any error is ignored, nothing depends on it. */
export function gzipEvents(dir: string): void {
  try {
    const file = join(dir, "events.jsonl");
    writeFileSync(`${file}.gz`, gzipSync(readFileSync(file)));
    rmSync(file);
  } catch {
    // keep the plain file
  }
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
  // unique across repositories too: a live batch in another root keeps its id
  do batch = newId("b");
  while (existsSync(join(dir, `${batch}.json`)) || batches.has(batch));
  const startedAt = new Date();
  const notes: string[] = [];
  const after = groups.map((g, i) =>
    groups.slice(0, i).flatMap((earlier, j) => {
      const path = overlap(earlier, g);
      if (!path) return [];
      notes.push(`steps ${earlier.label},${g.label} serialized (${path})`);
      return [j];
    }),
  );
  // shortcut: a need outside this delegation is not checked (it may have landed in an earlier call); check job records if plans rely on it
  const needs = groups.map((g) =>
    needsOf(g).flatMap((id) => {
      const j = groups.findIndex((o) => o.steps.some((s) => s.id === id));
      return j < 0 ? [] : [{ id, j }];
    }),
  );
  const ids: string[] = []; // by group
  const finals: (JobRecord | undefined)[] = [];
  const cmd = config.integration_cmd ?? config.test_cmd;
  const state: Integration = { integration: cmd ? "pending" : "none", verify: [] };
  let fix: ReturnType<typeof runGroup> | undefined;
  const record = (): BatchRecord => ({
    format: "cheapag/1",
    batch,
    groups: groups.map((g) => g.label),
    notes,
    ...state,
    jobs: ids.filter(Boolean),
  });
  const write = () => {
    const ended = finals.filter((r) => r !== undefined);
    const landed = ended.filter((r) => r.landed).map((r) => r.job); // in landing order: groups land in step order
    const { plan, steps } = shared.input;
    const endedAt = ended.length === groups.length ? new Date() : null;
    writeJson(batchFile(root, batch), { ...record(), plan, steps, landed, startedAt, endedAt });
  };

  // worker slots: held while a worker runs (BLOCKED included: its worktree and session stay live, and a reply resumes it at
  // once), released before waiting to land, so a later group can never starve an earlier one
  let free = config.limits.max_parallel;
  const queue: (() => void)[] = [];
  const acquire = () =>
    free > 0 ? (free--, Promise.resolve()) : new Promise<void>((resolve) => queue.push(resolve));
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
      const deps = await Promise.all(
        needs[i].map(async ({ id, j }) => ({ id, status: (await settled[j]).status })),
      );
      const failed = deps.find((d) => d.status !== "OK");
      if (failed) return `needs ${failed.id} (${failed.status})`;
      await acquire();
      holding = true;
    })();
    const run = runGroup({
      ...shared,
      progress: forward,
      group,
      batch,
      start,
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
    if (cmd && allLanded(ended))
      await integrate(
        root,
        cmd,
        batch,
        state,
        ended.map((r) => r.landed),
        write,
        async () => ({ ...shared, progress: forward }),
        (run) => (fix = run),
      );
    return ended;
  });
  // jobs in group order (renderBatch sorts by urgency)
  const render = () =>
    renderBatch(
      record(),
      runs.map((r) => r.record()),
      fix?.record(),
    );
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
  const entry = { root, look, render, forward };
  batches.set(batch, entry);
  void all.catch(() => {}).then(() => batches.delete(batch)); // a rejection reaches whoever looks
  return { all, ...entry };
}

/** A batch record's integration check fields; `verify` holds each check's run (its output is not kept). */
type Integration = Pick<BatchRecord, "integration" | "integrationError" | "fix"> & {
  verify: Omit<VerifyRun, "output">[];
};

/** Every group has ended with nothing left to land (each landed, was discarded or never got a worktree), and something did land. */
const allLanded = (jobs: Pick<JobRecord, "landed" | "worktree" | "status">[]) =>
  jobs.every(
    (j) => j.status !== "RUNNING" && j.status !== "BLOCKED" && (j.landed || !j.worktree),
  ) && jobs.some((j) => j.landed);

/**
 * The integration check (spec: Job lifecycle, A3 item 3): `cmd` on the combined working tree, under the land lock. A
 * failure starts one fix job on a fresh worktree of the combined state, on the normal path (self-fixes, escalation,
 * landing): integration passes when it lands OK, else fails with the check's error. `save` records each state change;
 * `fixer` gives what the fix job needs, only once one is needed (it may boot OpenCode).
 */
async function integrate(
  root: string,
  cmd: string,
  batch: string,
  state: Integration,
  landed: boolean[],
  save: () => void,
  fixer: () => Promise<Shared>,
  started: (fix: ReturnType<typeof runGroup>) => void,
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
    const fix = runGroup({
      ...shared,
      group: { label: groups.map((g) => g.label).join(","), steps: groups.flatMap((g) => g.steps) },
      batch,
      fix: { cmd, error },
    });
    state.fix = fix.job;
    started(fix);
    save();
    await fix.done;
    // shortcut: a fix that landed OK passes without checking the tree again (its own verify ran cmd on the combined state); re-check if the tree can drift meanwhile
    if (fix.record().status === "OK") state.integration = "pass";
    else Object.assign(state, { integration: "fail", integrationError: error });
  } catch (err) {
    Object.assign(state, {
      integration: "fail",
      integrationError: [`integration check: ${(err as Error).message}`],
    });
  } finally {
    save();
  }
}

/** Batches with a group still live in this server process, by id: how `jobs wait` and `reply` attach to them. */
const batches = new Map<
  string,
  {
    root: string;
    look: (once: boolean, progress: Progress) => Promise<string>;
    render: () => string;
    forward: Progress;
  }
>();

/** A test file, by the usual conventions: a tests/ directory, test_x / x_test / x.test / x.spec names, conftest.py. */
const TEST_FILE =
  /(^|\/)(tests?|testing|__tests__)\/|(^|\/)(test_[^/]*|[^/]*_tests?\.[a-z]+|[^/]*\.(test|spec)\.[a-z]+|conftest\.py)$/i;

/** The attempts on a failing check, in order: up to 2 self-fixes, then 1 escalation. */
const ATTEMPTS = ["fix 1", "fix 2", "esc"] as const;
type Attempt = (typeof ATTEMPTS)[number];

/** An attempt's tried: label: its name and the start of its own summary. */
function attemptLabel(name: string, fresh: FinishReport | undefined) {
  return `${name}: ${(fresh?.summary ?? "(no summary)").slice(0, 100)}`;
}

/** What a failed check sends back to the worker: fix it, with the error tail. */
const fixThis = (tail: string[]) =>
  `Verification failed. Fix the cause, then call finish again.\n\n${tail.join("\n")}`;
/** An attempt's own report; undefined when it reported nothing, so the last real report stands rather than a placeholder. */
const ownReport = (result: RunResult) =>
  result.finish || /```cheapag-result/.test(result.text) ? finishReport(result) : undefined;
/** How a fix attempt's check came out, against the failure before it. */
function verdict(before: string[], failing: { tail: string[] } | undefined) {
  if (!failing) return "passed";
  if (sameFailure(before, failing.tail)) return "same failure";
  return "different failure";
}

/** The answer a permission block's chosen option (its index; -1 for free text) gives the worker. */
function permissionAnswer(choice: number): PermissionAnswer {
  if (choice === 0) return "once";
  if (choice === 1) return "always";
  return "reject";
}

const FINDINGS_PROMPT =
  "You were stopped before finishing. Without calling any tool, answer in at most 600 characters: where the bug is (file:function), your best hypothesis, and what you ruled out.";
const FINDINGS_MS = 30_000;
/** The longest findings note kept; a longer one is cut, with an ellipsis as its last character. */
const MAX_FINDINGS = 600;

/** One last prompt on a stopped session for its findings; any error, timeout or empty answer gives none. */
async function findings(session: Session): Promise<string | undefined> {
  try {
    const r = await session.run(FINDINGS_PROMPT, undefined, AbortSignal.timeout(FINDINGS_MS), true);
    const text = (r.error || r.interrupted ? "" : r.text || r.finish?.summary || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return undefined;
    return text.length > MAX_FINDINGS ? `${text.slice(0, MAX_FINDINGS - 1)}…` : text;
  } catch {
    return undefined;
  }
}

/**
 * Checks the worker's reproduction test: its command must pass on the fixed tree and fail once the non-test
 * changes are set aside, which proves it tests the problem. The command comes from the worker, so it only runs when it
 * starts with a command this job may already run (done-when, test_cmd, allow_commands); anything else stays unverified.
 * `passed` are verify commands that already passed on this tree, so a claim equal to one skips the fixed-code rerun.
 */
async function checkRepro(
  worktree: Worktree,
  claim: string | undefined,
  allowed: string[],
  passed: string[],
  changed: string[],
  signal: AbortSignal,
): Promise<{ repro?: JobRecord["repro"]; risk?: string }> {
  const cwd = worktree.path;
  if (!claim || /^n\/?a\b/i.test(claim)) return {};
  if (/^none\b/i.test(claim))
    return {
      repro: "none",
      risk: `no reproduction: ${claim.replace(/^none:?\s*/i, "") || "the worker could not reproduce the problem"}`,
    };
  const runs = (cmd: string) =>
    runVerify(cwd, [cmd], () => {}, signal).then((r) => r[0]?.ok ?? false);
  const unverified = (why: string) => ({
    repro: "unverified" as const,
    risk: `nothing to do (the checks passed), reproduction not verified: ${why}`,
  }); // the action first: risks are clipped at 120 chars
  if (!allowed.some((a) => claim === a || claim.startsWith(a + " ")))
    return unverified(`\`${claim}\` is not one of this job's check commands`);
  if (!passed.includes(claim) && !(await runs(claim)))
    return unverified(`\`${claim}\` fails on the fixed code`);
  const fix = changed.filter((p) => !TEST_FILE.test(p));
  if (!fix.length) return unverified("the change has no code outside tests");
  // set the fix aside by file (tests stay), run the reproduction, then restore; landing uses the diff taken before this.
  // Files are saved in memory, never searched for or dropped in git's shared entry list, which the user's checkout also uses.
  const saved = new Map<string, Buffer | null>();
  let failsWithout = false;
  let restored = true;
  try {
    for (const file of fix) setAside(worktree, file, saved);
    failsWithout = !(await runs(claim));
  } catch {
    failsWithout = false;
    restored = false;
  } finally {
    // a failed restore only affects the worktree: the landing applies the diff taken before this check
    if (!restoreFiles(cwd, saved)) restored = false;
  }
  if (!restored) return unverified("could not set the fix aside to rerun the reproduction");
  return failsWithout
    ? { repro: "fail→pass" }
    : unverified(`\`${claim}\` also passes without the fix`);
}

/** Puts one changed file back to its base content, or removes it when the base has none; what it held goes into `saved`. */
function setAside(worktree: Worktree, file: string, saved: Map<string, Buffer | null>) {
  const cwd = worktree.path;
  const path = join(cwd, file);
  saved.set(file, existsSync(path) ? readFileSync(path) : null);
  const inBase =
    spawnSync("git", ["cat-file", "-e", `${worktree.base}:${file}`], { cwd, stdio: "pipe" })
      .status === 0;
  if (!inBase) {
    rmSync(path, { force: true });
    return;
  }
  const base = spawnSync("git", ["show", `${worktree.base}:${file}`], {
    cwd,
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (base.status !== 0) throw new Error(`git show ${worktree.base}:${file} failed`);
  writeFileSync(path, base.stdout);
}

/** Writes every saved file back, removing those that did not exist; false when any of them could not be restored. */
function restoreFiles(cwd: string, saved: Map<string, Buffer | null>) {
  let restored = true;
  for (const [file, content] of saved) {
    try {
      const path = join(cwd, file);
      if (content === null) rmSync(path, { force: true });
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    } catch {
      restored = false;
    }
  }
  return restored;
}

/** A question the worker asked, with the user's answer once given. */
type Asked = NonNullable<JobRecord["question"]>;

/** Why a job was stopped before it could finish: a cap, or `jobs cancel`. */
type Stop = { cap: "turns" | "minutes" | "cost" | "cancel" | "provider" | "down"; reason: string };
const STOPPED = {
  minutes: "TIMEOUT",
  cost: "BUDGET",
  cancel: "CANCELLED",
  provider: "BUDGET",
  down: "PROVIDER",
} as const;

/** A stopped job's status. Only a turn cap can leave usable work: PARTIAL when it changed files and its checks pass. */
function stoppedStatus(stop: Stop, usable: boolean): JobRecord["status"] {
  if (stop.cap !== "turns") return STOPPED[stop.cap];
  return usable ? "PARTIAL" : "FAIL";
}

/** How the escalation after a turn cap ended when it did not finish, for its tried: line. */
function escalationEnd(stop: Stop | undefined, result: RunResult) {
  if (stop) return `stopped: ${stop.reason}`;
  if (result.limit) return `usage limit: ${result.limit.message.slice(0, 80)}`;
  return "worker error";
}

/**
 * Jobs running in this server process, by id, across every repository it runs jobs in: how `jobs cancel` and `jobs wait`
 * reach them (a call's lookups go through `liveJob` for its root). `done` resolves to the final block, `settles()` at the
 * next settlement (BLOCKED or final); `block()` is the current block.
 */
const running = new Map<string, LiveJob>();
type LiveJob = {
  root: string;
  stop: (why: Stop) => void;
  done: Promise<string>;
  batch: string | null;
  settles: () => Promise<void>;
  block: () => string;
  parked: () => boolean;
};
/** The live job `id` in `root`, if one runs there in this server. */
const liveJob = (root: string, id: string) => {
  const live = running.get(id);
  return live?.root === root ? live : undefined;
};

export type JobsInput = {
  action: "list" | "show" | "wait" | "cancel";
  job?: string;
  seconds?: number;
  root?: string;
};

/** The `jobs` tool: list jobs, show one's last block again, wait for a job's or batch's next settlement, or cancel a running job. */
export async function jobs(input: JobsInput, progress: Progress = () => {}): Promise<string> {
  const root = callRoot(input.root);
  if (input.action === "list") return listJobs(root);
  if (input.action === "wait" && input.job && /^b[0-9a-z]{4}$/.test(input.job))
    return waitBatch(root, input.job, progress, input.seconds);
  if (!hasJobId(input))
    return failBlock(
      `jobs ${input.action} needs a job id, e.g. j7f3a${input.action === "wait" ? " or a batch id, e.g. b4k1x" : ""}`,
    );
  const live = liveJob(root, input.job);
  if (input.action === "wait" && live) return waitLiveJob(root, input, live);
  if (input.action === "cancel" && live) {
    live.stop({ cap: "cancel", reason: "cancelled on request" });
    return live.done;
  }
  return recordAnswer(root, input);
}

/** `jobs list`: the newest jobs' headlines, each BLOCKED one with how long it has waited. */
function listJobs(root: string) {
  const all = newestFirst(root);
  if (!all.length) return "no jobs yet";
  const lines = all.slice(0, LIST_MAX).map((r) => renderJob(r).split("\n")[0] + blockedFor(r));
  if (all.length > LIST_MAX) lines.push(`… +${all.length - LIST_MAX} older`);
  return lines.join("\n");
}

/** Whether the call names a well-formed job id: the id becomes a path, so only those get that far. */
function hasJobId(input: JobsInput): input is JobsInput & { job: string } {
  return !!input.job && JOB_ID.test(input.job);
}

/** `jobs wait` on a job live in this process: its block at its next settlement, or a check-in once `seconds` run out. */
async function waitLiveJob(root: string, input: JobsInput & { job: string }, live: LiveJob) {
  // a BLOCKED job only moves on a reply: its block now, rather than a wait that never ends
  if (blocked.has(input.job)) return live.block();
  if (input.seconds === undefined) {
    await live.settles();
    return live.block();
  }
  const waited = await waitOrTimeout(live.settles(), input.seconds);
  // settled just as the timer fired: the final block is more useful than a stale RUNNING line
  if (waited.timedOut && running.has(input.job))
    return runningCheckin(root, input.job, input.job, input.seconds);
  return live.block();
}

/** A job that is not live in this process, from its record: show, and wait on a finished job, give its block; the rest is refused. */
function recordAnswer(root: string, input: JobsInput & { job: string }) {
  const dir = jobDir(root, input.job);
  const record = readRecord(dir);
  if (!record) return failBlock(`job ${input.job} not found`);
  const block = () => readFileSync(join(dir, "result.txt"), "utf8").trimEnd();
  if (input.action === "show") return block();
  if (record.status === "RUNNING" || record.status === "BLOCKED") {
    return failBlock(
      `job ${input.job} is ${record.status} but not in this session (server pid ${record.pid ?? "unknown"}); ${input.action === "wait" ? "wait for" : "cancel"} it from the session that started it`,
    );
  }
  if (input.action === "wait") return block(); // finished: its final block at once
  return failBlock(`job ${input.job} already finished (${record.status}); nothing to cancel`);
}

/** `jobs wait` on a batch: the next settlement of a live one, or a finished one's block (from its records) at once. */
async function waitBatch(
  root: string,
  batch: string,
  progress: Progress,
  seconds?: number,
): Promise<string> {
  const found = batches.get(batch);
  const live = found?.root === root ? found : undefined;
  if (live) {
    if (seconds === undefined) return live.look(true, progress);
    const waited = await waitOrTimeout(live.look(true, progress), seconds);
    if (!waited.timedOut) return waited.value;
    const jobs = runningBatchJobs(root, batch);
    // everything settled just as the timer fired: the completed batch block is more useful
    return jobs.length ? runningCheckin(root, jobs, batch, seconds) : live.render();
  }
  let record: BatchRecord;
  try {
    record = JSON.parse(readFileSync(batchFile(root, batch), "utf8"));
  } catch {
    return failBlock(`batch ${batch} not found`);
  }
  // shortcut: a batch another live session runs is shown as its records stand, not waited on; wait from that session
  const jobRecords = record.jobs.map((id) => readRecord(jobDir(root, id)));
  if (jobRecords.some((r) => !r))
    return failBlock(`batch ${batch}: a job record is missing (cleaned up?)`);
  return renderBatch(
    record,
    jobRecords as JobRecord[],
    record.fix ? readRecord(jobDir(root, record.fix)) : undefined,
  );
}

/** A short check-in: each still-running job's latest progress line, then how to check again. */
function runningCheckin(root: string, jobs: string | string[], asked: string, seconds: number) {
  const ids = typeof jobs === "string" ? [jobs] : jobs;
  return [
    ...ids.map((job) => `RUNNING ${job} · ${progressLine(root, job)}`),
    `next: jobs(action="wait", job="${asked}", seconds=${seconds})`,
  ].join("\n");
}

/** The worker's latest progress line for a job, or `starting` before its first turn. */
function progressLine(root: string, job: string) {
  try {
    return readFileSync(join(jobDir(root, job), "progress.txt"), "utf8").trim() || "starting";
  } catch {
    return "starting";
  }
}

/** The batch's group jobs that are still RUNNING (not BLOCKED), from their records. */
function runningBatchJobs(root: string, batch: string) {
  try {
    const record = JSON.parse(readFileSync(batchFile(root, batch), "utf8")) as { jobs?: string[] };
    return (record.jobs ?? []).filter((id) => readRecord(jobDir(root, id))?.status === "RUNNING");
  } catch {
    return [];
  }
}

/** Resolves with the wait's value, or `timedOut` after `seconds`; the timer is always cleared. */
function waitOrTimeout<T>(
  wait: Promise<T>,
  seconds: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    wait.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true as const }), seconds * 1000);
    }),
  ]).finally(() => clearTimeout(timer));
}

const LIST_MAX = 20;

type StoredRecord = JobRecord & {
  pid?: number;
  batch?: string | null;
  timing?: { startedAt?: string; endedAt?: string | null; blockedAt?: string };
  baseline?: { tree?: string | null };
  discarded?: boolean;
};

/** How long a BLOCKED job has waited for a reply, as a suffix for its one-line headline (jobs list, cheapag status). */
export const blockedFor = (r: StoredRecord) =>
  r.status === "BLOCKED" && r.timing?.blockedAt && r.pid && isAlive(r.pid)
    ? ` waiting=${Math.floor((Date.now() - Date.parse(r.timing.blockedAt)) / 60_000)}m`
    : "";

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

/** The project's job records, newest first by start time. */
export const newestFirst = (root: string) =>
  records(root).sort((a, b) =>
    String(b.timing?.startedAt ?? "").localeCompare(String(a.timing?.startedAt ?? "")),
  );

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
    saveRecord(dir, { ...record, status: "CANCELLED", landed: false, reason: "server restart" });
  }
}

/** Jobs other than `job` that landed since `since`: who changed a file under it meanwhile. */
function landedSince(root: string, job: string, since: Date) {
  // shortcut: a job landed later by `land apply` counts by when it ended, not when it landed; add a landedAt if that misleads
  return records(root).filter(
    (r) => r.job !== job && r.landed && Date.parse(r.timing?.endedAt ?? "") >= since.getTime(),
  );
}

export type LandInput = { job: string; action: "apply" | "discard"; root?: string };

/**
 * The `land` tool (spec: Tool contracts, A13): `apply` 3-way applies unlanded jobs' worktree changes to the working
 * tree under the lock, in the order given, stopping at the first that fails; `discard` deletes their worktrees. One line
 * per job. Records are updated (`landed`, `worktree`, `discarded`) so research's unlanded note and cleanup stay truthful.
 */
export async function landJobs(input: LandInput, ctx: WorkerContext): Promise<string> {
  const root = callRoot(input.root);
  const ids = input.job
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length)
    return failBlock('land needs a job id, or several in landing order, e.g. "j7f3a,j7f3b"');
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
  const touched = new Set(
    ids.filter((id) => JOB_ID.test(id)).map((id) => readRecord(jobDir(root, id))?.batch),
  );
  for (const batch of touched) {
    const block = batch && (await integrateLater(root, config, batch, ctx));
    if (block) lines.push("", block);
  }
  return lines.join("\n");
}

/** A settled batch, still pending, with nothing left to land: runs its integration check and returns the batch block. */
async function integrateLater(root: string, config: Config, batch: string, ctx: WorkerContext) {
  const file = batchFile(root, batch);
  let record: BatchRecord & Integration & { plan: string; steps: string };
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // cleaned up
  }
  const cmd = config.integration_cmd ?? config.test_cmd;
  const jobRecords = record.jobs.map((id) => readRecord(jobDir(root, id)));
  if (
    batches.has(batch) ||
    !cmd ||
    !jobRecords.every((r) => r) ||
    !allLanded(jobRecords as JobRecord[])
  )
    return undefined;
  // claimed under the lock: two sessions landing a batch's last groups at once must not both run its check
  const claimed = await withLock(root, () => {
    const now = JSON.parse(readFileSync(file, "utf8")) as typeof record;
    if (now.integration !== "pending") return false;
    writeJson(file, { ...now, integration: "running" });
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
    return {
      root,
      input: { plan: record.plan, steps: record.steps },
      plan,
      config,
      route: gate.route,
      opencode,
      provider: ctx.provider,
      progress: ctx.progress,
    };
  };
  try {
    await integrate(
      root,
      cmd,
      batch,
      record,
      jobRecords.map((r) => r!.landed),
      () => writeJson(file, record),
      fixer,
      (run) => (fix = run),
    );
  } finally {
    release?.();
  }
  return renderBatch(record, jobRecords as JobRecord[], fix?.record());
}

/** Applies or discards one finished, unlanded job; returns its OK line, or throws why not. */
async function landOne(root: string, config: Config, id: string, action: LandInput["action"]) {
  if (!JOB_ID.test(id)) throw new Error(`${id} is not a job id, e.g. j7f3a`); // the id becomes a path
  const dir = jobDir(root, id);
  const record = readRecord(dir);
  if (!record) throw new Error(`job ${id} not found`);
  assertLandable(root, id, record);
  const worktree = jobWorktree(root, id, record.baseline?.tree ?? "", config.link_dirs);
  if (!worktree)
    throw new Error(`job ${id} has no worktree left (cleaned up); nothing to ${action}`);
  const save = (update: Partial<StoredRecord>) =>
    void saveRecord(dir, { ...record, ...update, worktree: null });
  if (action === "discard") {
    await dropWorktree(root, worktree);
    save({ discarded: true });
    return `OK ${id} discarded`;
  }
  if (!record.baseline?.tree)
    throw new Error(
      `job ${id} has no recorded base (made by an older version); land it by hand from .cheapag/worktrees/${id}/`,
    );
  const diff = worktreeDiff(worktree);
  // shortcut: two sessions applying the same job at once could both pass the checks above; the second 3-way apply then conflicts
  const clash = await land(
    root,
    id,
    diff.patch,
    diff.changed.map((c) => c.path),
  );
  if (clash) {
    const files = conflictPaths(clash);
    throw new Error(
      `landing conflict${files.length ? ` in ${files.join(", ")}` : ""}, working tree untouched; discard it, or fix the overlap and delegate again`,
    );
  }
  // the change is in the working tree now: a folder Windows won't delete yet must not undo the landing's record
  let cleanupError: string | undefined;
  try {
    await dropWorktree(root, worktree);
  } catch (err) {
    cleanupError = (err as Error).message.replace(/\s+/g, " ");
  }
  save({ landed: true, changed: diff.changed, ...(cleanupError && { cleanupError }) });
  const add = diff.changed.reduce((n, c) => n + c.add, 0);
  const del = diff.changed.reduce((n, c) => n + c.del, 0);
  const note = cleanupError
    ? `\ncleanup error: ${cleanupError} (the change landed; only its worktree folder was left behind)`
    : "";
  return `OK ${id} applied files=${diff.changed.length} +${add}/-${del}${note}`;
}

/** Throws why a finished job cannot be applied or discarded now: it is live, runs in another session, was settled already, or its batch still runs. */
function assertLandable(root: string, id: string, record: StoredRecord) {
  if (liveJob(root, id))
    throw new Error(`job ${id} is still ${record.status}; wait for it, or cancel it first`);
  if (record.status === "RUNNING" || record.status === "BLOCKED")
    throw new Error(
      `job ${id} is ${record.status} in another session (server pid ${record.pid ?? "unknown"})`,
    );
  if (record.landed) throw new Error(`job ${id} already landed`);
  if (record.discarded) throw new Error(`job ${id} was already discarded`);
  // landing it now would put it ahead of its batch's later groups, out of step order
  if (record.batch && batches.has(record.batch))
    throw new Error(
      `job ${id} belongs to batch ${record.batch}, still running; land it once the batch settles (jobs wait)`,
    );
}

/** Removes a job's worktree (dependency links unlinked first), after OpenCode has let go of the directory. */
async function dropWorktree(root: string, worktree: Worktree) {
  await releaseDirectory(worktree.path);
  removeWorktree(root, worktree);
}

/** A job paused on a worker question. It lives only in this process, as does its paused session. */
export type BlockedJob = {
  job: string;
  /** The repository the job runs in: ids are unique per repository, and one server can run jobs in several. */
  root: string;
  questions: Question[];
  /** A command permission ask: only the letters a, b, c answer it (a and c when always-allow is not offered). */
  permission?: boolean;
  /** Whether the block offered "always allow"; false means b is not an answer. */
  always?: boolean;
  /** Answers the questions (one answer each) and resumes the session; resolves with the job's next block (final, or BLOCKED again). */
  resume: (answers: string[], progress: Progress) => Promise<string>;
};
type Progress = (turns: number, message: string) => void;
const blocked = new Map<string, BlockedJob>();

/** The jobs waiting for a reply right now, by job id (for the jobs tool and a batch's early return). */
export const blockedJobs = (): ReadonlyMap<string, BlockedJob> => blocked;

/** `reply`: a letter picks that option's label, anything else is passed through as free text (spec D8). */
export async function reply(
  input: { job: string; answer: string; root?: string },
  progress: Progress,
): Promise<string> {
  const root = callRoot(input.root);
  const found = blocked.get(input.job);
  const entry = found?.root === root ? found : undefined;
  if (!entry) return failBlock(notWaiting(root, input.job));
  if (!input.answer.trim())
    return failBlock("empty answer; reply with an option letter or free text"); // the job stays BLOCKED
  if (entry.permission) {
    const refusal = permissionRefusal(entry, input.answer);
    if (refusal) return failBlock(refusal); // the job stays BLOCKED
  }
  const answers = readAnswers(input.answer, entry.questions);
  if (typeof answers === "string") return failBlock(answers); // the job stays BLOCKED
  // in a batch, the same early return as delegate from here (spec: reply resolves like delegate): the first BLOCKED, or all settled
  const batch = batches.get(running.get(input.job)?.batch ?? "");
  const next = entry.resume(answers, batch ? batch.forward : progress);
  return batch ? batch.look(false, progress) : next;
}

/** Why an answer cannot answer a command permission block, whose only answers are its letters. */
function permissionRefusal(entry: BlockedJob, answer: string) {
  const letters = entry.always === false ? /^\s*[ac]\)?\s*$/i : /^\s*[a-c]\)?\s*$/i;
  if (letters.test(answer)) return undefined;
  return entry.always === false ? "answer a or c" : "answer a, b or c";
}

/** One answer per question, or the error when the reply cannot be read. */
function readAnswers(answer: string, questions: Question[]) {
  // one question also takes the numbered form ("1a", "1: text") that several questions need
  const numbered = /^\s*1\s*(?:[a-d]\)?\s*$|:)/i.test(answer);
  if (questions.length === 1 && !numbered) return [pick(answer, questions[0])];
  return answerEach(answer, questions);
}

/** A letter picks that option's label; anything else is free text. */
function pick(answer: string, question: Question) {
  const letter = answer
    .trim()
    .toLowerCase()
    .match(/^([a-d])\)?$/)?.[1];
  return (letter && question.options[letter.charCodeAt(0) - 97]) || answer;
}

/** Several questions take one answer each, "1a, 2b" or "1a, 2: free text" (commas allowed in free text); the error when any is left out. */
function answerEach(answer: string, questions: Question[]): string[] | string {
  const answers: string[] = [];
  for (const part of answer.split(/,(?=\s*\d+\s*(?:[a-d]\)?\s*(?:,|$)|:))/i)) {
    const m = part.trim().match(/^(\d+)\s*(?:([a-d])\)?|:\s*([\s\S]*\S))$/i);
    const n = Number(m?.[1]) - 1;
    const option = m?.[2] && questions[n]?.options[m[2].toLowerCase().charCodeAt(0) - 97];
    if (!m || !questions[n] || answers[n] !== undefined || (m[2] && !option))
      return `cannot read "${part.trim()}" (or answered twice); answer each question as "1a, 2b" or "1a, 2: free text"`;
    answers[n] = option || m[3];
  }
  const missing = questions.map((_, i) => i + 1).filter((i) => !answers[i - 1]);
  return missing.length
    ? `unanswered: question ${missing.join(", ")}; answer each question as "1a, 2b" or "1a, 2: free text"`
    : answers;
}

/** Why `job` cannot take a reply, from its record on disk. */
function notWaiting(root: string, job: string) {
  const file = join(jobDir(root, job), "result.json");
  if (!JOB_ID.test(job) || !existsSync(file))
    return `no job ${job}; reply only to a BLOCKED job's id`;
  const { status } = JSON.parse(readFileSync(file, "utf8")) as { status: string };
  return status === "BLOCKED"
    ? `job ${job} is no longer waiting for a reply (already answered, or its session ended); delegate the step again`
    : `job ${job} is ${status}, not BLOCKED; only a BLOCKED job takes a reply`;
}

/** A fresh `j` + 4 base36 id whose job folder does not exist yet. */
function newJob(root: string) {
  for (;;) {
    const job = newId("j");
    const dir = jobDir(root, job);
    // unique across repositories too: a live job in another root keeps its id
    if (existsSync(dir) || running.has(job)) continue;
    mkdirSync(dir, { recursive: true });
    return { job, dir };
  }
}

/** `prefix` + 4 base36 chars: a job (`j`), batch (`b`) or research (`r`) id. */
export const newId = (prefix: string) =>
  `${prefix}${randomBytes(4).readUInt32BE().toString(36).slice(-4).padStart(4, "0")}`;

/**
 * The prompt after the agent's own rules (spec E2): the whole plan, then the current step(s), then the note.
 * shortcut: no repo map or CLAUDE.md/AGENTS.md excerpt yet; add them when worker quality needs the context.
 */
function contextPack(
  plan: Plan,
  steps: PlanStep[],
  note?: string,
  brief?: string,
  source?: string,
) {
  return [
    planText(plan),
    `>>> CURRENT STEP(S): ${steps.map((s) => s.id).join(", ")}\n\n${steps.map((s) => s.text).join("\n\n")}`,
    note && `Note: ${note}`,
    // start from what the scout found instead of re-exploring; an "unverified" repro is a lead, not a fact
    brief &&
      `Scout brief (from research; start here, and check anything marked unverified):\n${brief}`,
    // the user's own words: the step is Claude's reading of them, and only the worker sees both
    source &&
      `Source (the user's request or the issue, verbatim; check the step against it and report disagreements in finish's disagree):\n${source}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const planText = (plan: Plan) =>
  [`# ${plan.title}`, plan.context, ...plan.steps.map((s) => s.text)].filter(Boolean).join("\n\n");

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

/** The files a redo names as clashing: those with conflict markers, else those git named, else every changed file. */
function clashFiles(marked: string[], named: string[], changed: Changed[]) {
  if (marked.length) return marked;
  if (named.length) return named;
  return changed.map((c) => c.path);
}

/** Why a redo cannot land, checked in this order; undefined when it can. */
function redoFailure(redo: {
  result: RunResult;
  failing: unknown;
  worktree: Worktree;
  changed: Changed[];
}) {
  if (redo.result.error) return "redo worker error";
  if (redo.failing) return "redo failed verification";
  if (leftoverMarkers(redo.worktree).length) return "redo left conflict markers";
  if (!redo.changed.length) return "redo made no changes";
  return undefined;
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
    .filter(
      (m): m is RegExpMatchArray =>
        !!m && inside(base, join(base, m[1])) && existsSync(join(base, m[1])),
    )
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

/** A value as redacted, indented JSON, written whole. */
const writeJson = (path: string, value: unknown) =>
  writeWhole(path, redact(JSON.stringify(value, null, 2) + "\n"));

/** Writes a job record and its block (`result.json`, `result.txt`) into the job's folder, redacted; returns the block. */
function saveRecord(dir: string, record: JobRecord) {
  const text = renderJob(record);
  writeJson(join(dir, "result.json"), { ...record, blockTokensApprox: Math.ceil(text.length / 4) });
  writeWhole(join(dir, "result.txt"), redact(text + "\n"));
  return text;
}
