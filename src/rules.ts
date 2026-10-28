/**
 * The verification budget (ticket 23.3): Claude ran tests ~3 times per task, and again after an OK job. Part of the
 * server instructions, and appended verbatim to the benchmark's baseline arm so both arms get the same rule.
 */
export const VERIFY_RULE = "Tests: run only the test file or id the task concerns, once before if it names a failure and once after; never the whole suite; chain commands with &&.";

/**
 * Trusting results (ticket 24.1): reading the diff of every bigger OK cost +28% tokens and caught no wrong fix, so the
 * worker proves a fix with a reproduction test the server checks (repro= in the headline). Ticket 28: loose tests passed
 * wrong fixes ("both marks present" instead of their order), so on medium/hard tasks Claude reads the ~20-line test
 * instead of the diff. Part of the server instructions.
 */
export const REVIEW_RULE = "Trust an OK: don't re-run its tests or read its diff. After an OK on a task you rated medium or hard, or whose headline says repro=unverified or repro=none, read only its test= file once (without one, the diff) and check its assertions against the request: where they are looser than the request (\"does not crash\" or \"contains\" when a value, order or type is known), tighten them yourself and rerun that one file. After a FAIL or PARTIAL, do the task yourself instead of delegating it again: start from its found:, test= and worktree, open only the files they name, no background runs.";

/**
 * Delegate before reading (ticket 23.4): Claude read ~2 files before each delegation, so the code entered its context
 * anyway and the worker only typed. Part of the server instructions.
 */
export const SCOUT_RULE = "Don't open source files before delegating; the worker explores. To learn the code first, call research and pass its id as delegate brief:, not Read/Bash.";
