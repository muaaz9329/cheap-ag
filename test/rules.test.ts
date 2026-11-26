import { expect, test } from "vitest";
import { REVIEW_RULE, SCOUT_RULE, TAKE_OVER_RULE, VERIFY_RULE } from "../src/rules.js";

// These sentences go verbatim into the server instructions, so pin every character.

test("VERIFY_RULE: the test budget sentence", () => {
  expect(VERIFY_RULE).toBe(
    "Tests: run only the test file or id the task concerns, once before if it names a failure and once after; never the whole suite; chain commands with &&.",
  );
});

test("REVIEW_RULE: an OK is trusted as done", () => {
  expect(REVIEW_RULE).toBe("An OK is done: don't re-run its tests or read its diff or its test.");
});

test("TAKE_OVER_RULE: one sentence per take-over mode, and no other modes", () => {
  expect(TAKE_OVER_RULE).toStrictEqual({
    ask: "After a FAIL, PARTIAL or TIMEOUT, stop and ask the user one question: Claude (Sonnet subagent from found:, test= and worktree; 100k+ Claude tokens), retry the worker with model: (found: as note:), or stop. Do what they pick; never pick for them. A PARTIAL waits in worktree; land apply if they continue.",
    sonnet:
      "After a FAIL or PARTIAL (land apply a PARTIAL first), don't delegate it again or open files: give the step to your Agent tool with model: sonnet, passing the task, the user's words and the block's found:, test=, error: and worktree; report its answer, and if it did not finish, say what is left.",
    self: "After a FAIL or PARTIAL, do the task yourself instead of delegating it again: start from its found:, test= and worktree, open only the files they name, no background runs.",
  });
});

test("SCOUT_RULE: delegate before reading", () => {
  expect(SCOUT_RULE).toBe(
    "Don't open source files or research before delegating; the worker explores. Research only a question the task depends on; pass its id as delegate brief:.",
  );
});
