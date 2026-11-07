import { expect, test } from "vitest";
import { parsePlan } from "../src/plan.js";

test("plan steps accept kind: fix or change; any other value is a plan error", () => {
  const plan = (kind: string) => `# P\n## 1 a\nfiles: a.txt\ndone-when: done\nkind: ${kind}\n`;
  expect(parsePlan(plan("change")).steps[0].fields.kind).toBe("change");
  expect(parsePlan(plan("fix")).steps[0].fields.kind).toBe("fix");
  expect(() => parsePlan(plan("bogus"))).toThrow("step 1 (line 2): kind: must be fix, change or left out");
});
