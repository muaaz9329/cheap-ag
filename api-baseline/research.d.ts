import { type Provider } from "./credentials.js";
import { type Opencode } from "./opencode.js";
import { type ResearchRecord } from "./report.js";
import { type Route } from "./routing.js";
/**
 * Research: one question about the codebase, answered by a worker that reads, searches and runs test commands but
 * never edits (agent `cheapag-research`, ruleset `researchRuleset`), in a throwaway worktree of the developer's current
 * state (uncommitted work included) so a command can't touch their tree. It runs alongside jobs. The worker reports a
 * scout brief (ticket 23.4) in a fenced `cheapag-research` block in its final text; a claimed reproduction is checked
 * against the commands it actually ran.
 */
export declare const RESEARCH_AGENT = "cheapag-research";
export declare const MAX_WORDS = 600;
export type ResearchInput = {
    question: string;
    paths?: string;
    max_words?: number;
    root?: string;
};
type Answer = Pick<ResearchRecord, "status" | "answer" | "refs" | "confidence" | "repro" | "deadEnds" | "partial">;
export declare function research(input: ResearchInput, ctx: {
    provider: Provider;
    opencode: (route: Route) => Promise<Opencode>;
    progress: (turns: number, message: string) => void;
}): Promise<string>;
/** Research verifies before it claims (ticket 23.4: unverified handoffs inject false confidence). */
export declare const REPRO_RULE = "If the question is about a failure or wrong behaviour, reproduce it: run the relevant test or command and report exactly what it showed. Never claim a reproduction you did not run.";
export declare const BRIEF_FORMAT = "End your reply with exactly one fenced ```cheapag-research block: status (answer or unsure), confidence (high, medium or low), files (path:start-end, most relevant first, comma-separated), repro (`command` \u2192 what it showed, or not attempted), dead ends (what you ruled out, or none), then notes: and your prose.";
/**
 * A claimed reproduction stands only if its `command` is one the worker ran; otherwise it is marked unverified and the
 * confidence drops to low, so Claude doesn't build on a guess.
 */
export declare function verifyRepro(answer: Answer | undefined, ran: string[]): Answer | undefined;
/**
 * Jobs whose changes research cannot see (D7 note): not landed, and either still in flight (RUNNING or BLOCKED: their
 * changes may land later) or holding changes in a worktree that still exists (PARTIAL, FAIL, CONFLICT, TIMEOUT,
 * BUDGET, CANCELLED with edits; `land apply` could still land them). A discarded or cleaned-up job, or one that changed
 * nothing, has nothing to miss. Oldest first.
 */
export declare function unlandedJobs(root: string): string[];
/**
 * The worker's last fenced `cheapag-research` block, parsed leniently. Without one, its final text is the answer,
 * UNSURE with low confidence (the worker never rated it). Nothing at all → undefined.
 */
export declare function parseAnswer(text: string, root: string, scope: string[], maxWords: number): Answer | undefined;
/** The raw `path:line(-line)` candidates in text, before validation. Accepts a Windows drive letter and backslashes. */
export declare function refTokens(text: string): {
    path: string;
    from: string;
    to: string | undefined;
}[];
export {};
