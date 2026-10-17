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
export const SCOUT_RULE = "Don't open source files before delegating; the worker explores. To learn the code first, call research and pass its id as delegate brief:, not Read/Bash.";
