import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { finishReport, openSession, type FinishReport, type Session } from "./worker.js";
import { createWorktree, land, operationInProgress, projectRoot, removeWorktree, worktreeDiff, type Changed, type Worktree } from "./workspace.js";
import { normalisePath } from "./platform.js";

/** Jobs: runs one group of plan steps as one job, start to landing. */

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

  /** Runs the done conditions in the worktree; returns the failing run and its error tail, if any. */
  const verify = async () => {
    const runs = await runVerify(worktree!.path, cmds, (cmd) => ctx.progress(session!.totals().turns, `verify: ${cmd}`));
    verified.push(...runs);
    // the full output stays on disk; Claude only ever sees the tail
    for (const r of runs) appendFileSync(join(dir, "verify.log"), redact(`$ ${r.cmd}\n${r.output}\n(exit ${r.ok ? "ok" : "failed"}, ${r.ms} ms)\n\n`));
    const run = runs.find((r) => !r.ok);
    return run && { run, tail: errorTail(run, worktree!.path) };
  };

  try {
    worktree = createWorktree(root, job, config.link_dirs);
    session = await openSession({
      opencode,
      directory: worktree.path,
      model,
      permission: rulesetFor(worktree, cmds, config),
      onEvent: (event, turns) => {
        appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
        // one progress notification per worker turn; finer events (deltas, usage) would only be noise in /tasks
        if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
          const part = event.properties.part;
          if (part.state.status === "completed" || part.state.status === "error") ctx.progress(turns, `turn ${turns}: ${part.tool}`);
        }
      },
    });
    let result = await session.run(contextPack(plan, steps, input.note));
    report = finishReport(result);
    if (!result.error && cmds.length) {
      failing = await verify();
      // up to 2 self-fixes in the same session, then 1 escalation on the stronger model (spec: Job lifecycle)
      for (const attempt of ["fix 1", "fix 2", "esc"] as const) {
        if (!failing) break;
        const esc = attempt === "esc";
        if (esc && !escalation) {
          tried.push("esc: skipped, the escalation model is not allowed by this repo's consent");
          break;
        }
        if (esc) escalated = true;
        else selfFix++;
        const before = failing.tail;
        result = await session.run(`Verification failed. Fix the cause, then call finish again.\n\n${before.join("\n")}`, esc ? escalation : undefined);
        // an attempt that reports nothing keeps the last real report rather than a placeholder
        const fresh = result.finish || /```cheapag-result/.test(result.text) ? finishReport(result) : undefined;
        if (fresh) report = fresh;
        const label = `${esc ? "esc" : attempt}: ${(fresh?.summary ?? "(no summary)").slice(0, 100)}`;
        if (result.error) {
          tried.push(`${label} → worker error`);
          break;
        }
        failing = await verify();
        tried.push(`${label} → ${!failing ? "passed" : sameFailure(before, failing.tail) ? "same failure" : "different failure"}`);
      }
    }
    write("finish.json", report);
    const diff = worktreeDiff(worktree);
    changed = diff.changed;
    write("diff.patch", diff.patch); // the log copy is redacted; landing applies the in-memory patch
    if (result.error) {
      reason = `worker error: ${result.error}`;
    } else if (!failing) { // a verify failure is explained by the error: and tried: sections, not a reason
      const conflict = await land(root, job, diff.patch, diff.changed.map((c) => c.path));
      if (conflict) reason = `landing conflict, working tree untouched: ${conflict.split("\n")[0]}`;
      else removeWorktree(root, worktree);
    }
  } catch (err) {
    reason = (err as Error).message;
  }

  const landed = reason === undefined && !failing;
  const rejections = session?.totals().rejections ?? [];
  const risks = rejections.length > MAX_QUIET_REJECTIONS
    // first, so the 5-risk cap never cuts it
    ? [`${rejections.length} tool calls or permission requests were rejected; check the worker stayed in scope (see the log)`, ...report.risks]
    : report.risks;
  const record = {
    format: "cheapag/1" as const, job, batch: null, kind: "implement", status: (landed ? "OK" : "FAIL") as JobRecord["status"], landed,
    plan: input.plan, steps: stepIds, provider: ctx.provider.provider,
    models: { requested, final: escalated ? modelName(escalation!) : requested, fallbacks: [], escalated },
    baseline: { head: worktree?.head ?? null, stash: worktree?.stash ?? null },
    worktree: !landed && worktree ? normalisePath(relative(root, worktree.path)) : null,
    sessionID: session?.sessionID ?? null,
    // server-measured: "none" when nothing ran (no conditions, or the worker failed before verify)
    tests: (!verified.length ? "none" : failing ? "fail" : "pass") as JobRecord["tests"],
    error: failing?.tail,
    tried,
    summary: report.summary, changed, risks,
    // a landed job's files are in the working tree; an unlanded one's only in its worktree
    review: reviewRanges(report.review, landed || !worktree ? root : worktree.path),
    missing: report.missing, reason,
    verify: verified.map(({ cmd, ok, ms }) => ({ cmd, ok, ms })), selfFix, redo: 0, question: null, autoRejected: rejections,
    usage: { turns: session?.totals().turns ?? 0, ...(session?.totals().usage ?? { costUsd: 0 }) },
    timing: { startedAt, endedAt: new Date(), ms: Date.now() - startedAt.getTime() },
  };
  const text = renderJob(record);
  write("result.json", { ...record, blockTokensApprox: Math.ceil(text.length / 4) });
  write("result.txt", text + "\n");
  return text;
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
