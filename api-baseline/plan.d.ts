/** Plan format contract (spec D2): one H1, optional context, one H2 per step with lowercase `key:` fields. */
export type PlanStep = {
    id: string;
    title: string;
    fields: Record<string, string>;
    text: string;
};
export type Plan = {
    title: string;
    context: string;
    steps: PlanStep[];
};
/** The plan grammar in one line, for Claude: the delegate tool description and every plan-error FAIL carry it. */
export declare const PLAN_FORMAT = "Plan format: one \"# <title>\" line, then per step a \"## <id> <title>\" heading followed by \"files: <paths>\", \"do: <what>\", \"done-when: <check>\" (optional \"dont:\", \"needs: <step ids>\", \"difficulty: easy|medium|hard\", \"kind: fix|change\" (fix: a bug to reproduce, change: no reproduction expected)), each key at the start of its line, not a bullet. In done-when, `backticked` text is run as a shell command that must succeed; put only commands in backticks. Numbered or lettered list items count as separate changes, and a step or task with three or more is refused; write the details of one change as - bullets or prose.";
/** Parses a plan; throws with a precise, line-numbered reason when it does not follow the format. */
export declare function parsePlan(source: string): Plan;
/** One job's worth of steps, run in order in one session. `label` is how Claude wrote it ("3", "3-5"). */
export type Group = {
    label: string;
    steps: PlanStep[];
};
/**
 * Resolves a steps string to groups (spec D2): `"3"` one step, `"3-5"` a range run in order as one group, and commas
 * separate groups (`"1-2,3,4"`). Groups come back in plan order; a step may be in only one group.
 */
export declare function selectGroups(plan: Plan, spec: string): Group[];
/** Where two groups' `files:` overlap: an equal entry, or one inside the other's directory entry. Returns the inner path. */
export declare function overlap(a: Group, b: Group): string | undefined;
/** The step ids a group's `needs:` names, outside the group itself (a range already runs in order). */
export declare const needsOf: (g: Group) => string[];
