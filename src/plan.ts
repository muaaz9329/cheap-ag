/** Plan format contract (spec D2): one H1, optional context, one H2 per step with lowercase `key:` fields. */

export type PlanStep = { id: string; title: string; fields: Record<string, string>; text: string };
export type Plan = { title: string; context: string; steps: PlanStep[] };

const REQUIRED = ["files", "done-when"];

/** The plan grammar in one line, for Claude: the delegate tool description and every plan-error FAIL carry it. */
export const PLAN_FORMAT =
  'Plan format: one "# <title>" line, then per step a "## <id> <title>" heading followed by "files: <paths>", "do: <what>", "done-when: <check>" (optional "dont:"), each key at the start of its line, not a bullet. In done-when, `backticked` text is run as a shell command that must succeed; put only commands in backticks.';

/** Parses a plan; throws with a precise, line-numbered reason when it does not follow the format. */
export function parsePlan(source: string): Plan {
  const lines = source.split(/\r?\n/);
  let title: string | undefined;
  const context: string[] = [];
  const steps: (PlanStep & { line: number })[] = [];
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
      const m = line.match(/^## +(\d+[a-z]?)(?: +(.*))?$/);
      if (!m) throw new Error(`${at}: step heading needs an id (integer or integer+letter), e.g. "## 3 add route"`);
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
  }
  return { title, context: context.join("\n").trim(), steps: steps.map(({ line, ...step }) => ({ ...step, text: step.text.trim() })) };
}

/** Resolves a steps string to the steps of one group. Only a single step id for now. */
export function selectSteps(plan: Plan, spec: string): PlanStep[] {
  const want = spec.trim();
  // shortcut: ranges ("3-5") and comma groups arrive with ticket 14
  if (/[-,]/.test(want)) throw new Error(`steps "${spec}": only a single step id is supported yet; delegate one step at a time`);
  const step = plan.steps.find((s) => s.id === want);
  if (!step) throw new Error(`step ${want} not found (plan steps: ${plan.steps.map((s) => s.id).join(", ")})`);
  return [step];
}
