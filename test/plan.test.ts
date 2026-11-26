import { expect, test } from "vitest";
import { type Group, needsOf, overlap, parsePlan, selectGroups } from "../src/plan.js";

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

/** The message of the error a call throws; also pins that it is a plain Error. */
function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect((error as Error).constructor).toBe(Error);
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

test("parsePlan returns the title, the context and each step with its fields, text and field lines", () => {
  const source = [
    "intro before the title is ignored",
    "#not a heading",
    "#   My plan  ",
    "",
    "  indented first",
    "",
    "second",
    "## s1   First step  ",
    "files: a.txt",
    "do: write it",
    "done-when: `test -f a.txt`",
    "",
    "## 2",
    "done-when: ok",
    "files: b.txt",
    "",
    "",
  ].join("\r\n");
  const expected = {
    title: "My plan",
    context: "indented first\nsecond",
    steps: [
      {
        id: "1",
        title: "First step",
        fields: { files: "a.txt", do: "write it", "done-when": "`test -f a.txt`" },
        text: "## s1   First step  \nfiles: a.txt\ndo: write it\ndone-when: `test -f a.txt`",
        filesLine: 9,
        doLine: 10,
      },
      {
        id: "2",
        title: "",
        fields: { "done-when": "ok", files: "b.txt" },
        text: "## 2\ndone-when: ok\nfiles: b.txt",
        filesLine: 15,
      },
    ],
  };
  const plan = parsePlan(source);
  expect(plan).toStrictEqual(expected);
  // key order shows in JSON, so pin it too
  expect(JSON.stringify(plan)).toBe(JSON.stringify(expected));
});

test("parsePlan reads key: lines as fields, indented lines as continuations, and anything else as prose", () => {
  const lines = [
    "# T",
    "## 1 a",
    "files: a.txt",
    "do:first",
    "  second line",
    "",
    "    third",
    "\ttab line",
    "  after tab",
    "done-when:   spaced   ",
    "Note: capital keys are prose",
    "  not appended",
    "custom-key: kept",
    "### sub heading",
    "  not appended either",
    "files: b.txt",
    " one space",
    "  still not appended",
    "a1: x",
    "odd_key: y",
  ];
  const [step] = parsePlan(lines.join("\n")).steps;
  expect(JSON.stringify(step.fields)).toBe(
    JSON.stringify({
      files: "b.txt",
      do: "first\nsecond line\nthird",
      "done-when": "spaced",
      "custom-key": "kept",
    }),
  );
  expect(step).toMatchObject({ filesLine: 16, doLine: 4 });
  expect(step.text).toBe(lines.slice(1).join("\n"));
});

test("step headings take the id forms 3, s3, step3, step-3 and 3a, with an optional title", () => {
  const plan = parsePlan(
    "# P\n## step3 Title here\n## step-4\n## 5a x\n##   6  spaced  \n## 7  \n".replace(
      /\n(## [^\n]*)/g,
      "\n$1\nfiles: a\ndone-when: b",
    ),
  );
  expect(plan.steps.map((step) => [step.id, step.title])).toEqual([
    ["3", "Title here"],
    ["4", ""],
    ["5a", "x"],
    ["6", "spaced"],
    ["7", ""],
  ]);
});

test("parsePlan pins each line-scan error message", () => {
  const idHelp =
    'step heading needs an id (e.g. "## 3", "## s1", "## step-2", optionally with a letter like "3a")';
  expect(errorMessage(() => parsePlan("# T\n## Intro\n"))).toBe(`line 2: ${idHelp}`);
  expect(errorMessage(() => parsePlan("# T\n## 3A\n"))).toBe(`line 2: ${idHelp}`);
  expect(errorMessage(() => parsePlan("# T\n## 3ab\n"))).toBe(`line 2: ${idHelp}`);
  expect(errorMessage(() => parsePlan("# T\n## 8title\n"))).toBe(`line 2: ${idHelp}`);
  expect(errorMessage(() => parsePlan("# T\n\n## \n"))).toBe(`line 3: ${idHelp}`);
  expect(errorMessage(() => parsePlan("# T\n# Again\n"))).toBe(
    "line 2: a plan has exactly one H1 title",
  );
  expect(errorMessage(() => parsePlan("# T\n## 1\nfiles: a\ndone-when: b\n#  \n"))).toBe(
    "line 5: a plan has exactly one H1 title",
  );
  // the title check comes before the id check
  expect(errorMessage(() => parsePlan("intro\n## Intro\n# T\n"))).toBe(
    "line 2: step before the plan's H1 title",
  );
  expect(errorMessage(() => parsePlan("# T\n## step-1\nfiles: a\n## s1\n"))).toBe(
    "line 4: duplicate step id 1",
  );
  expect(errorMessage(() => parsePlan(""))).toBe('plan has no H1 title ("# <title>")');
  expect(errorMessage(() => parsePlan("just prose\n### 1 x\n"))).toBe(
    'plan has no H1 title ("# <title>")',
  );
  expect(errorMessage(() => parsePlan("# T\ncontext only\n"))).toBe(
    'plan has no steps ("## <id> <title>")',
  );
});

test("parsePlan pins each step-check error message", () => {
  const hidden =
    "is under .cheapag/, Cheap Agent's state folder, which workers cannot see; keep plans in .plan/ and targets in the repo";
  expect(errorMessage(() => parsePlan("# T\n## 1 a\ndo: x\n"))).toBe(
    "step 1 (line 2): missing files:, done-when:",
  );
  expect(errorMessage(() => parsePlan("# T\n## 1 a\ndone-when: x\n"))).toBe(
    "step 1 (line 2): missing files:",
  );
  // an empty value counts as missing
  expect(errorMessage(() => parsePlan("# T\n## 1 a\nfiles:\ndone-when: x\n"))).toBe(
    "step 1 (line 2): missing files:",
  );
  expect(
    errorMessage(() => parsePlan("# T\n## 1\nfiles: a\ndone-when: b\n\n## 2\ndone-when: b\n")),
  ).toBe("step 2 (line 6): missing files:");
  expect(
    errorMessage(() => parsePlan("# T\n## 1\nfiles: ./.cheapag/plan.md\ndone-when: b\n")),
  ).toBe(`line 3: step 1 files: .cheapag/plan.md ${hidden}`);
  // a continuation line is reported at its files: line, and the first hidden entry wins
  expect(
    errorMessage(() =>
      parsePlan("# T\n## 1\nfiles: a.txt\n  .cheapag, .cheapag/b\ndone-when: b\n"),
    ),
  ).toBe(`line 3: step 1 files: .cheapag ${hidden}`);
  // a repeated files: replaces the value and the line
  expect(
    errorMessage(() => parsePlan("# T\n## 1\nfiles: a.txt\nfiles: .cheapag/y\ndone-when: b\n")),
  ).toBe(`line 4: step 1 files: .cheapag/y ${hidden}`);
  expect(
    parsePlan("# T\n## 1\nfiles: src/.cheapag/x, .cheapagx/y, .cheapag-notes/z\ndone-when: b\n")
      .steps,
  ).toHaveLength(1);
});

test("parsePlan counts numbered and lettered changes in do:, at line start or after . ; or :", () => {
  const plan = (doLines: string) => `# P\n## 2 x\nfiles: a.txt\ndo: ${doLines}\ndone-when: done\n`;
  const split = (count: number) =>
    `line 4: step 2 lists ${count} changes; one change per step: split it into 2a, 2b, … (needs: orders them), or use - bullets for the details of one change`;
  expect(errorMessage(() => parsePlan(plan("(1) one; (2) two; (3) three")))).toBe(split(3));
  expect(errorMessage(() => parsePlan(plan("a. one\n  b) two\n  c. three")))).toBe(split(3));
  expect(errorMessage(() => parsePlan(plan("fix it: a) x; b) y; c) z; d) w")))).toBe(split(4));
  expect(parsePlan(plan("(1) one (2) two (3) three")).steps).toHaveLength(1);
  expect(parsePlan(plan("x\n  - 1. a; 2) b; 3) c\n  * a) b; c) d; e) f")).steps).toHaveLength(1);
  expect(parsePlan("# P\n## 1\nfiles: a\ndone-when: b\n").steps[0]).not.toHaveProperty("doLine");
});

test("parsePlan reports the first problem: line-scan errors in line order, then each step's checks in order", () => {
  const step = (lines: string[]) => `# P\n## 1 a\n${lines.join("\n")}\n`;
  const doLine = "do: 1. a; 2. b; 3. c";
  expect(
    errorMessage(() =>
      parsePlan(step(["difficulty: tricky", "kind: bogus", "files: .cheapag/x", doLine])),
    ),
  ).toBe("step 1 (line 2): missing done-when:");
  const done = "done-when: ok";
  expect(
    errorMessage(() =>
      parsePlan(step(["difficulty: tricky", "kind: bogus", "files: .cheapag/x", doLine, done])),
    ),
  ).toBe("step 1 (line 2): difficulty: must be easy, medium, hard or left out");
  expect(
    errorMessage(() => parsePlan(step(["kind: bogus", "files: .cheapag/x", doLine, done]))),
  ).toBe("step 1 (line 2): kind: must be fix, change or left out");
  expect(errorMessage(() => parsePlan(step(["files: .cheapag/x", doLine, done])))).toBe(
    "line 3: step 1 files: .cheapag/x is under .cheapag/, Cheap Agent's state folder, which workers cannot see; keep plans in .plan/ and targets in the repo",
  );
  expect(errorMessage(() => parsePlan(step(["files: a.txt", doLine, done])))).toBe(
    "line 4: step 1 lists 3 changes; one change per step: split it into 1a, 1b, … (needs: orders them), or use - bullets for the details of one change",
  );
  // steps are checked one by one: step 1's last check beats step 2's first
  expect(
    errorMessage(() => parsePlan(step(["files: a.txt", doLine, done, "## 2 b", "do: x"]))),
  ).toBe(
    "line 4: step 1 lists 3 changes; one change per step: split it into 1a, 1b, … (needs: orders them), or use - bullets for the details of one change",
  );
  // any line-scan error beats every step check, and the earliest line wins
  expect(errorMessage(() => parsePlan(step(["do: x", "## 2", "## 2", "# Again"])))).toBe(
    "line 5: duplicate step id 2",
  );
});

const PLAN_OF_FIVE = parsePlan(
  `# P\n${["1", "2", "3", "3a", "4"].map((id) => `## ${id}\nfiles: ${id}.txt\ndone-when: ok\n`).join("")}`,
);

test("selectGroups returns label and steps per group, in plan order, sharing the plan's step objects", () => {
  const groups = selectGroups(PLAN_OF_FIVE, " 4 , s1 - step-2,3-3a ");
  expect(groups.map((group) => group.label)).toEqual(["1-2", "3-3a", "4"]);
  expect(groups.map((group) => group.steps.map((step) => step.id))).toEqual([
    ["1", "2"],
    ["3", "3a"],
    ["4"],
  ]);
  expect(groups.map((group) => Object.keys(group))).toEqual([
    ["label", "steps"],
    ["label", "steps"],
    ["label", "steps"],
  ]);
  expect(groups[0].steps[0]).toBe(PLAN_OF_FIVE.steps[0]);
  expect(selectGroups(PLAN_OF_FIVE, "3-3").map((group) => group.label)).toEqual(["3-3"]);
  expect(selectGroups(PLAN_OF_FIVE, "s3").map((group) => group.label)).toEqual(["3"]);
});

test("selectGroups pins each error message and reports the first bad part", () => {
  const notFound = (id: string) => `step ${id} not found (plan steps: 1, 2, 3, 3a, 4)`;
  const notAnId = (spec: string, part: string) =>
    `steps "${spec}": "${part}" is not a step id or range; use e.g. "3", "3-5" or "1-2,3,4" (a heading "## s1" is step 1)`;
  const select = (spec: string) => errorMessage(() => selectGroups(PLAN_OF_FIVE, spec));
  expect(select("9")).toBe(notFound("9"));
  expect(select("s9")).toBe(notFound("9"));
  expect(select("8-9")).toBe(notFound("8"));
  expect(select("1-9")).toBe(notFound("9"));
  expect(select("")).toBe(notAnId("", ""));
  expect(select("1,,2")).toBe(notAnId("1,,2", ""));
  expect(select("1-")).toBe(notAnId("1-", "1-"));
  expect(select("2-1")).toBe('steps "2-1": range 2-1 runs backwards');
  expect(select("s2 - s1 ")).toBe('steps "s2 - s1 ": range s2 - s1 runs backwards');
  expect(select("1-2,2")).toBe('steps "1-2,2": step 2 is in more than one group');
  expect(select("1-3,2-4")).toBe('steps "1-3,2-4": step 2 is in more than one group');
  // parts are checked left to right, each fully before the next
  expect(select("1,1,9")).toBe('steps "1,1,9": step 1 is in more than one group');
  expect(select("9,x")).toBe(notFound("9"));
  expect(select("x,9")).toBe(notAnId("x,9", "x"));
  expect(select("9-1")).toBe(notFound("9"));
  expect(select("2-1,x")).toBe('steps "2-1,x": range 2-1 runs backwards');
});

test("selectGroups refuses a group that needs a later group, checked in plan order after all parts", () => {
  const plan = parsePlan(
    "# P\n## 1\nfiles: a\ndone-when: ok\nneeds: 3\n## 2\nfiles: b\ndone-when: ok\nneeds: 3, 4\n" +
      "## 3\nfiles: c\ndone-when: ok\n## 4\nfiles: d\ndone-when: ok\nneeds: 1\n",
  );
  const select = (spec: string) => errorMessage(() => selectGroups(plan, spec));
  const later = (spec: string, label: string, id: string) =>
    `steps "${spec}": step ${label} needs ${id}, which comes later in the plan; put dependencies first`;
  expect(select("2,1,3")).toBe(later("2,1,3", "1", "3"));
  expect(select("1-3,4")).toBe(later("1-3,4", "1-3", "4"));
  expect(select("2,3-4")).toBe(later("2,3-4", "2", "3"));
  expect(select("1,3,3")).toBe('steps "1,3,3": step 3 is in more than one group');
  expect(selectGroups(plan, "1-3").map((group) => group.label)).toEqual(["1-3"]);
  expect(selectGroups(plan, "4,1").map((group) => group.label)).toEqual(["1", "4"]);
});

/** A group with one step per files: value; overlap reads nothing else. */
function groupOfFiles(...files: string[]): Group {
  return {
    label: "g",
    steps: files.map((value, index) => ({
      id: String(index + 1),
      title: "",
      fields: { files: value },
      text: "",
    })),
  };
}

test("overlap returns the inner path of the first overlapping pair, or undefined", () => {
  expect(overlap(groupOfFiles("a.txt"), groupOfFiles("b.txt"))).toBeUndefined();
  expect(overlap(groupOfFiles("a.txt"), groupOfFiles("b.txt, a.txt"))).toBe("a.txt");
  expect(overlap(groupOfFiles("./src/"), groupOfFiles("src/a.ts"))).toBe("src/a.ts");
  expect(overlap(groupOfFiles("src/a.ts"), groupOfFiles("src//"))).toBe("src/a.ts");
  expect(overlap(groupOfFiles("src"), groupOfFiles("srcx/a.ts"))).toBeUndefined();
  expect(overlap(groupOfFiles(" , ,a.txt\nb.txt"), groupOfFiles("b.txt"))).toBe("b.txt");
  expect(overlap(groupOfFiles(","), groupOfFiles(","))).toBeUndefined();
  expect(overlap(groupOfFiles("./"), groupOfFiles("/"))).toBeUndefined();
  expect(overlap(groupOfFiles("a/x, b"), groupOfFiles("b, a"))).toBe("a/x");
  expect(overlap(groupOfFiles("a.txt", "b.txt"), groupOfFiles("b.txt"))).toBe("b.txt");
});

test("needsOf lists a group's needs once each, in order, without the group's own steps", () => {
  const group: Group = {
    label: "1-2",
    steps: [
      { id: "1", title: "", fields: { files: "a", needs: "3, 4  5" }, text: "" },
      { id: "2", title: "", fields: { files: "b", needs: "4,1 s6\n7" }, text: "" },
    ],
  };
  // needs ids are not normalised like heading ids: s6 stays s6
  expect(needsOf(group)).toEqual(["3", "4", "5", "s6", "7"]);
  expect(needsOf(groupOfFiles("a"))).toEqual([]);
  expect(
    needsOf({ label: "1", steps: [{ id: "1", title: "", fields: { needs: "" }, text: "" }] }),
  ).toEqual([]);
});
