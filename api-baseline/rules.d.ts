import type { TakeOver } from "./config.js";
/**
 * The verification budget (ticket 23.3): Claude ran tests ~3 times per task, and again after an OK job. Part of the
 * server instructions, and appended verbatim to the benchmark's baseline arm so both arms get the same rule.
 */
export declare const VERIFY_RULE = "Tests: run only the test file or id the task concerns, once before if it names a failure and once after; never the whole suite; chain commands with &&.";
/**
 * Trusting results (ticket 24.1): reading the diff of every bigger OK cost +28% tokens and caught no wrong fix. Ticket 30:
 * unverified OKs were as correct as verified ones (83% vs 80%) yet re-checking them cost 229k tokens vs 63k, so every OK is
 * trusted and the hook enforces it. Part of the server instructions.
 */
export declare const REVIEW_RULE = "An OK is done: don't re-run its tests or read its diff or its test.";
/**
 * Who finishes a step the worker could not (ticket 30). With Opus doing it, a failure costs at least what stock does,
 * capping the saving near 1.9x; a Sonnet subagent working from the worker's found: note does it at a fraction of the
 * usage. The hook enforces either: sonnet leaves Opus only Agent and cheapag's tools, self caps its tool calls.
 */
export declare const TAKE_OVER_RULE: Record<TakeOver, string>;
/**
 * Delegate before reading (ticket 23.4): Claude read ~2 files before each delegation, so the code entered its context
 * anyway and the worker only typed. Ticket 65, speed test 2026-11-22: research on a 2-file repo cost 47s before the first
 * delegate and the worker re-read the same files anyway. Part of the server instructions.
 */
export declare const SCOUT_RULE = "Don't open source files or research before delegating; the worker explores. Research only a question the task depends on; pass its id as delegate brief:.";
