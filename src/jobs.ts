import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { redact, type Provider } from "./credentials.js";
import type { Opencode } from "./opencode.js";
import { parsePlan, PLAN_FORMAT, selectSteps, type Plan, type PlanStep } from "./plan.js";
import { failBlock, renderJob, type JobRecord } from "./report.js";
import { loadConfig, type Config } from "./config.js";
import { projectScripts, workerRuleset } from "./permissions.js";
import { consentGate } from "./consent.js";
import { modelName, type Route } from "./routing.js";
import { errorTail, runVerify, sameFailure, verifyCommands, type VerifyRun } from "./verify.js";
import { finishReport, openSession, type FinishReport, type Question, type Session } from "./worker.js";
import { createWorktree, land, operationInProgress, projectRoot, removeWorktree, worktreeDiff, type Changed, type Worktree } from "./workspace.js";
import { isAlive, normalisePath } from "./platform.js";

/** Jobs: runs one group of plan steps as one job, start to landing, under per-job caps; lists, shows and cancels jobs. */

/**
 * The worker session's ruleset for this job. The step's own done-when checks are allowed exactly as written, so the
 * worker can check its work before finishing (Cheap Agent runs them anyway); the hard denylist still comes last.
 */
function rulesetFor(worktree: Worktree, cmds: string[], config: Config) {
  const { scripts, exact } = projectScripts(worktree.path);
  return workerRuleset({ scripts, exact: [...exact, ...cmds], allowCommands: config.allow_commands, linked: worktree.linked });
}

/** More rejections than this in one job earn a risk line. */
const MAX_QUIET_REJECTIONS = 5;

export type DelegateInput = { plan: string; steps: string; note?: string };

export async function delegate(
  input: DelegateInput,
  ctx: { provider: Provider; opencode: (route: Route) => Promise<Opencode>; progress: (turns: number, message: string) => void },
): Promise<string> {
  const root = projectRoot(process.cwd());
  // first: an unapproved repo gets CONSENT before any job, worktree, OpenCode boot or provider call
  const gate = consentGate(root, ctx.provider.provider);
  if ("block" in gate) return gate.block;
  const { route } = gate;
  const planFile = join(root, input.plan);
  if (isAbsolute(input.plan) || !inside(root, planFile)) return failBlock(`plan ${input.plan} must be a path inside the repository, relative to its root`);
  if (!existsSync(planFile)) return failBlock(`plan ${input.plan} not found`);
  let plan: Plan;
  let steps: PlanStep[];
  try {
    plan = parsePlan(readFileSync(planFile, "utf8"));
  } catch (err) {
    return failBlock(`plan ${input.plan}: ${(err as Error).message}\n${PLAN_FORMAT}`);
  }
  try {
    steps = selectSteps(plan, input.steps);
  } catch (err) {
    return failBlock(`plan ${input.plan}: ${(err as Error).message}`);
  }

  let config: Config;
  try {
    config = loadConfig(root);
  } catch (err) {
    return failBlock((err as Error).message);
  }
  const cmds = verifyCommands(steps.map((s) => s.fields["done-when"]), config.test_cmd);
  const busy = operationInProgress(root);
  if (busy) return failBlock(`${busy} in the working tree; finish or abort it, then delegate again`);

  const opencode = await ctx.opencode(route);
  const { job, dir } = newJob(root);
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"));
  const stepIds = steps.map((s) => s.id).join(",");
  const model = route.implement;
  const requested = modelName(model);
  const startedAt = new Date();
  write("request.json", { ...input, steps: stepIds, model: requested, startedAt });

  const escalation = route.escalation;
  // whoever is waiting on this job right now: delegate first, then each reply
  let progress = ctx.progress;
  let settle!: (text: string) => void;
  const nextOutcome = () => new Promise<string>((resolve) => (settle = resolve));
  const outcome = nextOutcome();
  let asked: JobRecord["question"] = null;
  let worktree: Worktree | undefined;
  let session: Session | undefined;
  let report: FinishReport = finishReport({ text: "" });
  let changed: Changed[] = [];
  let reason: string | undefined;
  const verified: VerifyRun[] = [];
  const tried: string[] = [];
  let selfFix = 0;
  let escalated = false;
  let failing: { run: VerifyRun; tail: string[] } | undefined;
  let checked = false; // whether verify has seen the worker's latest changes

  // caps count across the whole job; any stop aborts the session, and all but the turn cap also kill verify
  const { limits } = config;
  const halt = new AbortController(); // the worker session
  const kill = new AbortController(); // verify processes: a turn cap still runs one last check, so PARTIAL never hides failing tests
  let stopped = undefined as Stop | undefined; // set from callbacks: keep TS from narrowing it to undefined
  let landing = false;
  const stop = (why: Stop) => {
    // a landing in progress finishes; a turn cap's last check may still be cut short by the clock or a cancel
    if (landing || (stopped && (stopped.cap !== "turns" || why.cap === "turns"))) return;
    stopped = why;
    blocked.delete(job); // a reply arriving now must not resume a stopped job
    halt.abort();
    if (why.cap !== "turns") kill.abort();
  };
  const overCost = () => {
    if (session && session.totals().usage.costUsd >= limits.max_cost_usd) stop({ cap: "cost", reason: `job cap ($${limits.max_cost_usd.toFixed(2)}) reached` });
  };
  const overTurns = () => {
    if (session && session.totals().turns >= limits.max_turns) stop({ cap: "turns", reason: `turn cap (${limits.max_turns}) reached` });
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
    clearTimeout(timer);
    clockLeft -= Date.now() - clockStarted;
  };
  startClock();
  let finished!: (text: string) => void;
  running.set(job, { stop, done: new Promise((resolve) => (finished = resolve)) });

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

  /** Builds the job record as it stands, writes it and returns its block. */
  const finalize = (status: JobRecord["status"]) => {
    const landed = status === "OK";
    // a BLOCKED worker has not finished: no report, no verify yet (the renderer omits what is absent)
    const waiting = status === "BLOCKED";
    const rejections = session?.totals().rejections ?? [];
    const risks = rejections.length > MAX_QUIET_REJECTIONS
      // first, so the 5-risk cap never cuts it
      ? [`${rejections.length} tool calls or permission requests were rejected; check the worker stayed in scope (see the log)`, ...report.risks]
      : report.risks;
    const record = {
      format: "cheapag/1" as const, job, batch: null, kind: "implement", status, landed,
      plan: input.plan, steps: stepIds, provider: ctx.provider.provider,
      // the server process running the job: a restart finds RUNNING/BLOCKED records whose pid is gone
      pid: process.pid,
      models: { requested, final: escalated ? modelName(escalation!) : requested, fallbacks: [], escalated },
      baseline: { head: worktree?.head ?? null, stash: worktree?.stash ?? null },
      worktree: !landed && worktree ? normalisePath(relative(root, worktree.path)) : null,
      sessionID: session?.sessionID ?? null,
      // server-measured: "none" when nothing ran (no conditions, or the worker failed before verify)
      tests: waiting ? undefined : ((!verified.length ? "none" : failing ? "fail" : "pass") as JobRecord["tests"]),
      error: failing?.tail,
      tried,
      summary: waiting ? "" : report.summary, changed, risks: waiting ? [] : risks,
      // a landed job's files are in the working tree; an unlanded one's only in its worktree
      review: reviewRanges(report.review, landed || !worktree ? root : worktree.path),
      // a worker stopped at the turn cap rarely says what it left undone
      missing: status === "PARTIAL" && !report.missing.length ? [`unknown: stopped at the turn cap (${limits.max_turns}); compare the diff with the step`] : report.missing,
      reason,
      verify: verified.map(({ cmd, ok, ms }) => ({ cmd, ok, ms })), selfFix, redo: 0, question: asked, autoRejected: rejections,
      usage: { turns: session?.totals().turns ?? 0, ...(session?.totals().usage ?? { costUsd: 0 }) },
      timing: { startedAt, endedAt: status === "RUNNING" || waiting ? null : new Date(), ms: Date.now() - startedAt.getTime() },
    };
    const text = renderJob(record);
    write("result.json", { ...record, blockTokensApprox: Math.ceil(text.length / 4) });
    write("result.txt", text + "\n");
    return text;
  };

  /** The worker asked: the job is BLOCKED, its block goes to whoever waits, and the session stays paused until `reply` resumes it. */
  const onQuestion = (question: Question) => new Promise<string>((answer) => {
    pauseClock();
    asked = { text: question.question, options: question.options, answer: null };
    changed = worktreeDiff(worktree!).changed;
    blocked.set(job, {
      job, question,
      resume: (text, replyProgress) => {
        blocked.delete(job);
        startClock();
        progress = replyProgress;
        asked = { text: question.question, options: question.options, answer: text };
        const after = nextOutcome();
        answer(text);
        return after;
      },
    });
    settle(finalize("BLOCKED"));
  });

  finalize("RUNNING");
  // the job outlives this call when it blocks: it settles each outcome in turn (BLOCKED, then whatever follows a reply)
  void (async () => {
    try {
      worktree = createWorktree(root, job, config.link_dirs);
      session = await openSession({
        opencode,
        directory: worktree.path,
        model,
        permission: rulesetFor(worktree, cmds, config),
        onQuestion,
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
              if (part.tool !== "finish") overTurns();
            }
          }
          if (event.type === "message.updated") overCost();
        },
      });
      finalize("RUNNING"); // now with the worktree, so a restart can point at it
      let result = await session.run(contextPack(plan, steps, input.note));
      report = finishReport(result);
      if (!result.error && cmds.length) {
        failing = await verify();
        // up to 2 self-fixes in the same session, then 1 escalation on the stronger model (spec: Job lifecycle)
        for (const attempt of ["fix 1", "fix 2", "esc"] as const) {
          if (!failing) break;
          overTurns(); // a fix needs at least one more turn
          if (halt.signal.aborted) break; // stopped (cap or cancel)
          const esc = attempt === "esc";
          if (esc && !escalation) {
            tried.push("esc: skipped, the escalation model is not allowed by this repo's consent");
            break;
          }
          if (esc) escalated = true;
          else selfFix++;
          const before = failing.tail;
          result = await session.run(`Verification failed. Fix the cause, then call finish again.\n\n${before.join("\n")}`, esc ? escalation : undefined);
          checked = false;
          // an attempt that reports nothing keeps the last real report rather than a placeholder
          const fresh = result.finish || /```cheapag-result/.test(result.text) ? finishReport(result) : undefined;
          if (fresh) report = fresh;
          const label = `${esc ? "esc" : attempt}: ${(fresh?.summary ?? "(no summary)").slice(0, 100)}`;
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
      write("finish.json", report);
      const diff = worktreeDiff(worktree);
      changed = diff.changed;
      write("diff.patch", diff.patch); // the log copy is redacted; landing applies the in-memory patch
      if (stopped) {
        // a capped or cancelled job never lands; its worktree is kept
      } else if (result.error) {
        reason = `worker error: ${result.error}`;
      } else if (!failing) { // a verify failure is explained by the error: and tried: sections, not a reason
        landing = true; // from here on, caps and cancel no longer apply
        clearTimeout(timer);
        const conflict = await land(root, job, diff.patch, diff.changed.map((c) => c.path));
        if (conflict) reason = `landing conflict, working tree untouched: ${conflict.split("\n")[0]}`;
        else removeWorktree(root, worktree);
      }
    } catch (err) {
      reason = (err as Error).message;
    }
    clearTimeout(timer);
    running.delete(job);
    blocked.delete(job);
    let status: JobRecord["status"] = !stopped && reason === undefined && !failing ? "OK" : "FAIL";
    if (stopped) {
      // the cap or cancel explains the stop, not the aborted prompt's error
      reason = stopped.reason;
      status = stopped.cap === "turns" ? (changed.length && !failing ? "PARTIAL" : "FAIL") : STOPPED[stopped.cap];
      if (status === "PARTIAL") reason = undefined; // spec D5: PARTIAL says it through missing:
    }
    const text = finalize(status);
    finished(text);
    settle(text);
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
    settle(text);
  });
  return outcome;
}

/** Why a job was stopped before it could finish: a cap, or `jobs cancel`. */
type Stop = { cap: "turns" | "minutes" | "cost" | "cancel"; reason: string };
const STOPPED = { minutes: "TIMEOUT", cost: "BUDGET", cancel: "CANCELLED" } as const;

/** Jobs running in this server process, by id: how `jobs cancel` reaches them. `done` resolves to the final block. */
const running = new Map<string, { stop: (why: Stop) => void; done: Promise<string> }>();

export type JobsInput = { action: "list" | "show" | "cancel"; job?: string };

/** The `jobs` tool: list jobs, show one's last block again, or cancel a running one. */
export async function jobs(input: JobsInput): Promise<string> {
  const root = projectRoot(process.cwd());
  if (input.action === "list") {
    const all = records(root).sort((a, b) => String(b.timing?.startedAt ?? "").localeCompare(String(a.timing?.startedAt ?? "")));
    if (!all.length) return "no jobs yet";
    const lines = all.slice(0, LIST_MAX).map((r) => renderJob(r).split("\n")[0]);
    if (all.length > LIST_MAX) lines.push(`… +${all.length - LIST_MAX} older`);
    return lines.join("\n");
  }
  // the id becomes a path: only well-formed ids get that far
  if (!input.job || !/^j[0-9a-z]{4}$/.test(input.job)) return failBlock(`jobs ${input.action} needs a job id, e.g. j7f3a`);
  const live = running.get(input.job);
  if (input.action === "cancel" && live) {
    live.stop({ cap: "cancel", reason: "cancelled on request" });
    return live.done;
  }
  const dir = join(root, ".cheapag", "jobs", input.job);
  const record = readRecord(dir);
  if (!record) return failBlock(`job ${input.job} not found`);
  if (input.action === "show") return readFileSync(join(dir, "result.txt"), "utf8").trimEnd();
  if (record.status === "RUNNING" || record.status === "BLOCKED") {
    return failBlock(`job ${input.job} is ${record.status} but not in this session (server pid ${record.pid ?? "unknown"}); cancel it from the session that started it`);
  }
  return failBlock(`job ${input.job} already finished (${record.status}); nothing to cancel`);
}

const LIST_MAX = 20;

type StoredRecord = JobRecord & { pid?: number; timing?: { startedAt?: string } };

function readRecord(dir: string): StoredRecord | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  } catch {
    return undefined; // no record yet, or unreadable
  }
}

/** Every readable job record in the project, with the folder it lives in. */
function records(root: string) {
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
    writeFileSync(join(dir, "result.json"), redact(JSON.stringify({ ...cancelled, blockTokensApprox: Math.ceil(text.length / 4) }, null, 2) + "\n"));
    writeFileSync(join(dir, "result.txt"), redact(text + "\n"));
  }
}

/** A job paused on a worker question. It lives only in this process, as does its paused session. */
export type BlockedJob = {
  job: string;
  question: Question;
  /** Answers the question and resumes the session; resolves with the job's next block (final, or BLOCKED again). */
  resume: (answer: string, progress: Progress) => Promise<string>;
};
type Progress = (turns: number, message: string) => void;
const blocked = new Map<string, BlockedJob>();

/** The jobs waiting for a reply right now, by job id (for the jobs tool and a batch's early return). */
export const blockedJobs = (): ReadonlyMap<string, BlockedJob> => blocked;

/** `reply`: a letter picks that option's label, anything else is passed through as free text (spec D8). */
export async function reply(input: { job: string; answer: string }, progress: Progress): Promise<string> {
  const entry = blocked.get(input.job);
  if (!entry) return failBlock(notWaiting(input.job));
  const letter = input.answer.trim().toLowerCase().match(/^([a-d])\)?$/)?.[1];
  const option = letter && entry.question.options[letter.charCodeAt(0) - 97];
  return entry.resume(option || input.answer, progress);
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
    const job = `j${randomBytes(4).readUInt32BE().toString(36).slice(-4).padStart(4, "0")}`;
    const dir = join(root, ".cheapag", "jobs", job);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    return { job, dir };
  }
}

/**
 * The prompt after the agent's own rules (spec E2): the whole plan, then the current step(s), then the note.
 * shortcut: no repo map or CLAUDE.md/AGENTS.md excerpt yet; add them when worker quality needs the context.
 */
function contextPack(plan: Plan, steps: PlanStep[], note?: string) {
  const whole = [`# ${plan.title}`, plan.context, ...plan.steps.map((s) => s.text)].filter(Boolean).join("\n\n");
  return [
    whole,
    `>>> CURRENT STEP(S): ${steps.map((s) => s.id).join(", ")}\n\n${steps.map((s) => s.text).join("\n\n")}`,
    note && `Note: ${note}`,
  ].filter(Boolean).join("\n\n");
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
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${"/"}`) && rel !== ".." && !isAbsolute(rel);
};
