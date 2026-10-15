import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { redact, type Provider } from "./credentials.js";
import type { Opencode } from "./opencode.js";
import { parsePlan, PLAN_FORMAT, selectSteps, type Plan, type PlanStep } from "./plan.js";
import { failBlock, renderJob, type JobRecord } from "./report.js";
import { IMPLEMENT_MODEL, modelName } from "./routing.js";
import { finishReport, runSession, type FinishReport, type SessionResult } from "./worker.js";
import { createWorktree, land, projectRoot, removeWorktree, worktreeDiff, type Changed } from "./workspace.js";

/** Jobs: runs one group of plan steps as one job, start to landing. */

export type DelegateInput = { plan: string; steps: string; note?: string };

export async function delegate(
  input: DelegateInput,
  ctx: { provider: Provider; opencode: () => Promise<Opencode>; progress: (turns: number, message: string) => void },
): Promise<string> {
  const root = projectRoot(process.cwd());
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

  const opencode = await ctx.opencode();
  const { job, dir } = newJob(root);
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"));
  const stepIds = steps.map((s) => s.id).join(",");
  const model = IMPLEMENT_MODEL[ctx.provider.provider];
  const requested = modelName(model);
  const startedAt = new Date();
  write("request.json", { ...input, steps: stepIds, model: requested, startedAt });

  let worktree: { head: string; path: string } | undefined;
  let session: SessionResult | undefined;
  let report: FinishReport = finishReport({ text: "" });
  let changed: Changed[] = [];
  let reason: string | undefined;
  try {
    // shortcut: no carry-over of uncommitted state or dependency links yet (ADR-0003); ticket 06 adds them
    worktree = createWorktree(root, job);
    session = await runSession({
      opencode,
      directory: worktree.path,
      model: { providerID: model.providerID, id: model.id }, // options live in the generated config, not the session
      prompt: contextPack(plan, steps, input.note),
      onEvent: (event, turns) => {
        appendFileSync(join(dir, "events.jsonl"), redact(JSON.stringify(event)) + "\n");
        // one progress notification per worker turn; finer events (deltas, usage) would only be noise in /tasks
        if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
          const part = event.properties.part;
          if (part.state.status === "completed" || part.state.status === "error") ctx.progress(turns, `turn ${turns}: ${part.tool}`);
        }
      },
    });
    report = finishReport(session);
    write("finish.json", report);
    const diff = worktreeDiff(worktree.path, worktree.head);
    changed = diff.changed;
    write("diff.patch", diff.patch); // the log copy is redacted; landing applies the in-memory patch
    if (session.error) {
      reason = `worker error: ${session.error}`;
    } else {
      const conflict = await land(root, job, diff.patch);
      if (conflict) reason = `landing conflict, working tree untouched: ${conflict.split("\n")[0]}`;
      else removeWorktree(root, worktree.path);
    }
  } catch (err) {
    reason = (err as Error).message;
  }

  const landed = reason === undefined;
  const record = {
    format: "cheapag/1" as const, job, batch: null, kind: "implement", status: (landed ? "OK" : "FAIL") as JobRecord["status"], landed,
    plan: input.plan, steps: stepIds, provider: ctx.provider.provider,
    models: { requested, final: requested, fallbacks: [], escalated: false },
    baseline: { head: worktree?.head ?? null, stash: null },
    worktree: !landed && worktree ? relative(root, worktree.path) : null,
    sessionID: session?.sessionID ?? null,
    summary: report.summary, changed, risks: report.risks,
    // a landed job's files are in the working tree; an unlanded one's only in its worktree
    review: reviewRanges(report.review, landed || !worktree ? root : worktree.path),
    missing: report.missing, reason,
    verify: [], selfFix: 0, redo: 0, question: null, autoRejected: 0,
    usage: { turns: session?.turns ?? 0, ...(session?.usage ?? { costUsd: 0 }) },
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
