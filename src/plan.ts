import { DIFFICULTIES, type Difficulty } from "./routing.js";

/** Plan format contract (spec D2): one H1, optional context, one H2 per step with lowercase `key:` fields. */

export type PlanStep = { id: string; title: string; fields: Record<string, string>; text: string };
export type Plan = { title: string; context: string; steps: PlanStep[] };

const REQUIRED = ["files", "done-when"];

/** The plan grammar in one line, for Claude: the delegate tool description and every plan-error FAIL carry it. */
export const PLAN_FORMAT =
  'Plan format: one "# <title>" line, then per step a "## <id> <title>" heading followed by "files: <paths>", "do: <what>", "done-when: <check>" (optional "dont:", "needs: <step ids>", "difficulty: easy|medium|hard"), each key at the start of its line, not a bullet. In done-when, `backticked` text is run as a shell command that must succeed; put only commands in backticks.';

/** Parses a plan; throws with a precise, line-numbered reason when it does not follow the format. */
export function parsePlan(source: string): Plan {
  const lines = source.split(/\r?\n/);
  let title: string | undefined;
  const context: string[] = [];
  const steps: (PlanStep & { line: number; doLine?: number; filesLine?: number })[] = [];
  let field: string | undefined;

  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/^# /.test(line)) {
      if (title !== undefined) throw new Error(`${at}: a plan has exactly one H1 title`);
      title = line.slice(2).trim();
      return;
    }
    if (/^## /.test(line)) {
      if (title === undefined) throw new Error(`${at}: step before the plan's H1 title`);
      // s1, step2, step-2 and plain 3 all normalise to the digits (plus an optional letter, like 3a)
      const m = line.match(/^## +(?:step-?|s)?(\d+[a-z]?)(?: +(.*))?$/);
      if (!m) throw new Error(`${at}: step heading needs an id (e.g. "## 3", "## s1", "## step-2", optionally with a letter like "3a")`);
      if (steps.some((s) => s.id === m[1])) throw new Error(`${at}: duplicate step id ${m[1]}`);
      steps.push({ id: m[1], title: (m[2] ?? "").trim(), fields: {}, text: line, line: i + 1 });
      field = undefined;
      return;
    }
    const step = steps.at(-1);
    if (!step) {
      if (title !== undefined && line.trim()) context.push(line);
      return;
    }
    step.text += `\n${line}`;
    const kv = line.match(/^([a-z][a-z-]*):\s?(.*)$/);
    if (kv) {
      field = kv[1];
      if (field === "do") step.doLine = i + 1;
      if (field === "files") step.filesLine = i + 1;
      step.fields[field] = kv[2].trim();
    } else if (/^ {2,}\S/.test(line) && field) {
      step.fields[field] += `\n${line.trim()}`;
    } else if (line.trim()) {
      field = undefined; // free prose inside a step is kept in its text, not a field
    }
  });

  if (title === undefined) throw new Error("plan has no H1 title (\"# <title>\")");
  if (!steps.length) throw new Error("plan has no steps (\"## <id> <title>\")");
  for (const step of steps) {
    const missing = REQUIRED.filter((key) => !step.fields[key]);
    if (missing.length) throw new Error(`step ${step.id} (line ${step.line}): missing ${missing.map((k) => `${k}:`).join(", ")}`);
    const d = step.fields.difficulty;
    if (d !== undefined && !DIFFICULTIES.includes(d as Difficulty)) throw new Error(`step ${step.id} (line ${step.line}): difficulty: must be ${DIFFICULTIES.join(", ")} or left out`);
    const hidden = step.fields.files.split(/[,\n]/).map((f) => f.trim().replace(/^\.\//, "")).find((f) => f.split("/")[0] === ".cheapag");
    if (hidden) throw new Error(`line ${step.filesLine}: step ${step.id} files: ${hidden} is under .cheapag/, Cheap Agent's state folder, which workers cannot see; keep plans in .plan/ and targets in the repo`);
    const changes = countChanges(step.fields.do ?? "");
    if (changes >= 3) throw new Error(`line ${step.doLine}: step ${step.id} lists ${changes} changes; one change per step: split it into ${step.id}a, ${step.id}b, … (needs: orders them)`);
  }
  return { title, context: context.join("\n").trim(), steps: steps.map(({ line, ...step }) => ({ ...step, text: step.text.trim() })) };
}

const MARK = "(?:\\d+[.)]|\\(\\d+\\)|[a-z][.)])";
const LEAD = new RegExp(`^${MARK}\\s`);
const INLINE = new RegExp(`[.;:] ${MARK}\\s`, "g");

/** Numbered/lettered items in a `do:` text, at line start or inline after `.`, `;` or `:`; bullets are not counted. */
function countChanges(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^[-*] /.test(line)) continue;
    n += +LEAD.test(line) + (line.match(INLINE)?.length ?? 0);
  }
  return n;
}

/** One job's worth of steps, run in order in one session. `label` is how Claude wrote it ("3", "3-5"). */
export type Group = { label: string; steps: PlanStep[] };

/**
 * Resolves a steps string to groups (spec D2): `"3"` one step, `"3-5"` a range run in order as one group, and commas
 * separate groups (`"1-2,3,4"`). Groups come back in plan order; a step may be in only one group.
 */
export function selectGroups(plan: Plan, spec: string): Group[] {
  const index = (id: string) => {
    const i = plan.steps.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`step ${id} not found (plan steps: ${plan.steps.map((s) => s.id).join(", ")})`);
    return i;
  };
  const seen = new Set<string>();
  const groups = spec.split(",").map((raw) => {
    const part = raw.trim();
    // same id forms as headings: s1, step1, step-1 normalise to the digits
    const m = part.match(/^(?:step-?|s)?(\d+[a-z]?)(?:\s*-\s*(?:step-?|s)?(\d+[a-z]?))?$/);
    if (!m) throw new Error(`steps "${spec}": "${part}" is not a step id or range; use e.g. "3", "3-5" or "1-2,3,4" (a heading "## s1" is step 1)`);
    const [from, to] = [index(m[1]), index(m[2] ?? m[1])];
    if (to < from) throw new Error(`steps "${spec}": range ${part} runs backwards`);
    const steps = plan.steps.slice(from, to + 1);
    for (const s of steps) {
      if (seen.has(s.id)) throw new Error(`steps "${spec}": step ${s.id} is in more than one group`);
      seen.add(s.id);
    }
    return { label: m[2] ? `${m[1]}-${m[2]}` : m[1], steps, at: from };
  });
  const sorted = groups.sort((a, b) => a.at - b.at).map(({ at, ...g }) => g);
  // groups land in step order, so a group waiting on a later one would never land
  sorted.forEach((g, i) => {
    const later = needsOf(g).find((id) => sorted.slice(i + 1).some((o) => o.steps.some((s) => s.id === id)));
    if (later) throw new Error(`steps "${spec}": step ${g.label} needs ${later}, which comes later in the plan; put dependencies first`);
  });
  return sorted;
}

/** Where two groups' `files:` overlap: an equal entry, or one inside the other's directory entry. Returns the inner path. */
export function overlap(a: Group, b: Group): string | undefined {
  const files = (g: Group) =>
    g.steps.flatMap((s) => s.fields.files.split(/[,\n]/)).map((f) => f.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  const theirs = files(b);
  for (const x of files(a)) {
    for (const y of theirs) {
      if (x === y || x.startsWith(`${y}/`)) return x;
      if (y.startsWith(`${x}/`)) return y;
    }
  }
  return undefined;
}

/** The step ids a group's `needs:` names, outside the group itself (a range already runs in order). */
export const needsOf = (g: Group) =>
  [...new Set(g.steps.flatMap((s) => (s.fields.needs ?? "").split(/[\s,]+/).filter(Boolean)))].filter((id) => !g.steps.some((s) => s.id === id));
