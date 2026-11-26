import { expect, test } from "vitest";
import { parsePlan } from "../src/plan.js";

test("plan steps accept kind: fix or change; any other value is a plan error", () => {
  const plan = (kind: string) => `# P\n## 1 a\nfiles: a.txt\ndone-when: done\nkind: ${kind}\n`;
  expect(parsePlan(plan("change")).steps[0].fields.kind).toBe("change");
  expect(parsePlan(plan("fix")).steps[0].fields.kind).toBe("fix");
  expect(() => parsePlan(plan("bogus"))).toThrow(
    "step 1 (line 2): kind: must be fix, change or left out",
  );
});

test("free prose inside a step ends the field before it: later indented lines are not appended to that field", () => {
  const plan = parsePlan(
    "# T\n## 1 a\nfiles: a.txt\ndo: write it\nsome free prose\n  indented after the prose\ndone-when: it exists\n",
  );
  expect(plan.steps[0].fields).toEqual({
    files: "a.txt",
    do: "write it",
    "done-when": "it exists",
  });
  expect(plan.steps[0].text).toContain("some free prose\n  indented after the prose");
  // without the prose line, an indented line continues the field
  expect(
    parsePlan("# T\n## 1 a\nfiles: a.txt\ndo: write it\n  and more\ndone-when: x\n").steps[0].fields
      .do,
  ).toBe("write it\nand more");
});
