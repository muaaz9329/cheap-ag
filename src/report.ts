import type { Changed } from "./workspace.js";

/** Report: renders result blocks (format contract `cheapag/1`, spec D3) from job records. Pure. */

export type JobRecord = {
  format: "cheapag/1";
  job: string;
  status: "OK" | "FAIL";
  landed: boolean;
  steps: string;
  summary: string;
  changed: Changed[];
  risks: string[];
  review: { path: string; start: number; end: number }[];
  missing: string[];
  reason?: string;
  worktree: string | null;
  usage: { turns: number; costUsd: number };
};

const CHANGED_MAX = 15;

/** A FAIL before any job exists (bad input, setup). */
export const failBlock = (reason: string) => `FAIL reason: ${reason}`;

export function renderJob(r: JobRecord) {
  const add = r.changed.reduce((n, c) => n + c.add, 0);
  const del = r.changed.reduce((n, c) => n + c.del, 0);
  const lines = [
    `${r.status} ${r.job} step=${r.steps} files=${r.changed.length} +${add}/-${del} tests=none turns=${r.usage.turns} cost=$${r.usage.costUsd.toFixed(3)}`,
    `summary: ${r.summary.slice(0, 160)}`,
  ];
  if (r.changed.length) {
    lines.push("changed:");
    for (const c of r.changed.slice(0, CHANGED_MAX)) {
      lines.push(`  ${c.status} ${c.path}${c.add ? ` +${c.add}` : ""}${c.del ? ` -${c.del}` : ""}`);
    }
    if (r.changed.length > CHANGED_MAX) lines.push(`  … +${r.changed.length - CHANGED_MAX} more`);
  }
  if (r.risks.length) lines.push("risks:", ...r.risks.slice(0, 5).map((risk) => `  - ${risk.slice(0, 120)}`));
  if (r.review.length) lines.push(`review: ${r.review.map((v) => `${v.path}:${v.start}-${v.end}`).join(", ")}`);
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.worktree) lines.push(`worktree: ${r.worktree}/`);
  lines.push(`log: .cheapag/jobs/${r.job}/`);
  return lines.join("\n");
}
