/**
 * The verification budget (ticket 23.3): Claude ran tests ~3 times per task, and again after an OK job. Shared by the
 * server instructions, the SessionStart context and the plan-writing skill, and appended verbatim to the benchmark's
 * baseline arm so both arms get the same rule.
 */
export const VERIFY_RULE = "Tests: run only the test file or id the task concerns, once before if it names a failure and once after; never the whole suite; chain commands with &&.";

/**
 * Delegate before reading (ticket 23.4): Claude read ~2 files before each delegation, so the code entered its context
 * anyway and the worker only typed. Shared like VERIFY_RULE.
 */
/**
 * Review before accepting (hard tier of 23.4b): the worker's own checks passed but the fix was wrong on 2 of 12 hard runs,
 * and with "trust OK" Claude never looked. Small OKs are still trusted; bigger ones get one diff read. Shared like VERIFY_RULE.
 */
export const REVIEW_RULE = "Trust a small OK (at most 30 changed lines in at most 2 files, empty risks:) without re-running tests or reading the diff; for a bigger OK, read the diff once and check it against the task; if it is wrong or incomplete, fix it yourself. After a FAIL, do the task yourself instead of delegating it again.";

export const SCOUT_RULE = "Don't open source files before delegating; the worker explores. To learn the code first, call research and pass its id as delegate brief:, not Read/Bash.";
