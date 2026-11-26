import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import { gitBash, killProcessGroup, normalisePath } from "./platform.js";

/** Verify: runs a job's executable done conditions in its worktree and condenses failures into an error tail. */

export type VerifyRun = {
  cmd: string;
  ok: boolean;
  ms: number;
  output: string;
  code: number | null;
  signal: string | null;
};

// a backstop per command; the job's minute cap (its `signal`) bounds the whole job
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;

/** The backticked fragments of each step's `done-when`, in order; else the configured test_cmd; else none. */
export function verifyCommands(doneWhen: string[], testCmd?: string) {
  const backticked = doneWhen
    .flatMap((text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()))
    .filter(Boolean);
  if (backticked.length) return backticked;
  return testCmd ? [testCmd] : [];
}

/**
 * Every string the ruleset must allow for one check command, so the worker can run it as written: the command
 * itself, plus each `&&`/`||`/`;`/`|` segment (OpenCode checks segments separately), each as typed and with its
 * leading `NAME=value` (or `export NAME=value`) assignments stripped. De-duplicated, in first-seen order.
 */
export function checkAllows(cmd: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const value = s.trim();
    if (value && !out.includes(value)) out.push(value);
  };
  add(cmd);
  for (const segment of cmd.split(/&&|\|\||;|\|/)) {
    add(segment);
    const stripped = segment
      .trim()
      .replace(/^(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
      .trim();
    if (stripped) add(stripped);
  }
  return out;
}

/**
 * Runs the commands in order in `cwd`, stopping at the first failure; `onStart` hears each command as it begins.
 * Aborting `signal` kills the running command's process group (cap or cancel) and fails it.
 */
export async function runVerify(
  cwd: string,
  cmds: string[],
  onStart: (cmd: string) => void,
  signal?: AbortSignal,
): Promise<VerifyRun[]> {
  const runs: VerifyRun[] = [];
  for (const cmd of cmds) {
    if (signal?.aborted) break;
    onStart(cmd);
    const run = await runOne(cwd, cmd, signal);
    runs.push(run);
    if (!run.ok) break;
  }
  return runs;
}

/** Starts `cmd` in `cwd` in its own process group, so everything it spawned can be stopped with it. */
function spawnCheck(cwd: string, cmd: string) {
  // checks are written in bash syntax; on Windows run them through Git Bash when we have it, else let Node pick the shell
  const bash = process.platform === "win32" ? gitBash() : undefined;
  const env = { ...process.env, CI: "1", FORCE_COLOR: "0" };
  const options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  };
  if (bash) return spawn(bash, ["-c", cmd], options);
  return spawn(cmd, { shell: true, ...options });
}

function runOne(cwd: string, cmd: string, signal?: AbortSignal): Promise<VerifyRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawnCheck(cwd, cmd);
    const killGroup = () => killProcessGroup(child.pid, "SIGKILL");
    let output = "";
    let code: number | null = null;
    let exitSignal: string | null = null;
    // keep the end: failures and summaries come last
    const collect = (chunk: string) => (output = (output + chunk).slice(-OUTPUT_LIMIT));
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      output += `\n(cheapag: stopped after ${COMMAND_TIMEOUT_MS / 60_000} min)`;
      killGroup();
    }, COMMAND_TIMEOUT_MS);
    const halt = () => {
      output += "\n(cheapag: stopped, job cap or cancel)";
      killGroup();
    };
    signal?.addEventListener("abort", halt, { once: true });
    // a backgrounded child (`server &`) would hold the pipes open: when the shell exits, stop its whole group
    child.on("exit", (exitCode, exitSignalValue) => {
      code = exitCode;
      exitSignal = exitSignalValue;
      killGroup();
    });
    const finish = (run: VerifyRun) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", halt);
      resolve(run);
    };
    child.on("close", () =>
      finish({
        cmd,
        ok: code === 0 && !signal?.aborted,
        ms: Date.now() - started,
        output,
        code,
        signal: exitSignal,
      }),
    );
    child.on("error", (error) =>
      finish({
        cmd,
        ok: false,
        ms: Date.now() - started,
        output: error.message,
        code: null,
        signal: null,
      }),
    );
  });
}

// output only a shell or dynamic loader emits when it cannot run the command at all
const ENV_OUTPUT =
  /command not found|dyld|Abort trap|is not recognized as an internal or external command|cannot execute binary|No such file or directory: .*\b(node|npx|python3?|pytest|go|cargo)\b/i;

/**
 * Why a failed check looks environmental (a missing tool or a broken Node) rather than a failing test: the exit code,
 * the signal, or a phrase only a shell or loader emits. `undefined` when the run passed or failed like ordinary code.
 */
export function envFailure(run: VerifyRun): string | undefined {
  // a run cheapag itself stopped (job cap, cancel, command timeout) died of our SIGKILL: not the environment's fault
  if (run.ok || /\(cheapag: stopped/.test(run.output)) return undefined;
  if (run.signal) return `signal ${run.signal}`;
  if (run.code === 127) return "exit 127: command not found";
  if (run.code === 134) return "exit 134 (dyld abort)";
  const match = run.output.match(ENV_OUTPUT);
  return match ? `exit ${run.code ?? "?"}: ${match[0].trim()}` : undefined;
}

const MARKER = /✗|✘|×|\bFAIL\b|Error:|error TS\d+|AssertionError|Traceback|panicked|^E\s{2,}/;
const DETAIL = /expected|received|\bgot\b|\bwant\b|^\s*[-+] /i;
const FRAME = /^\s*(at |File ")|\.(ts|tsx|js|mjs|cjs|py|go|rs):\d+/;
// pass lines and progress only: a line that also carries a failure marker is never noise
const NOISE =
  /^\s*(✓|√|PASS\b|ok\b)|^\s*(Tests?|Test Files|Suites?)\b.*\bpassed\b|^\s*[.·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/;
const MAX_FAILURES = 3;
const MAX_LINES = 25;

type Failure = { key: string; lines: string[]; count: number };

/**
 * Spec D9: the failing command, then up to 3 distinct failures (similar ones counted ×N), each with its message,
 * expected/received lines and first in-repo frame; at most 25 lines of 200 chars, with `root` made repo-relative.
 * Falls back to the last lines when no failure marker is found.
 */
export function errorTail(run: VerifyRun, root: string): string[] {
  const lines = tailLines(run.output, root);
  const failures = findFailures(lines);
  const body = failures.length
    ? failures.slice(0, MAX_FAILURES).flatMap(failureLines)
    : lines.slice(-(MAX_LINES - 1));
  return [`\`${run.cmd}\``, ...body.slice(0, MAX_LINES - 1).map((l) => clip(`  ${l}`))];
}

/** A failure's lines, its headline counting its repeats (×N). */
function failureLines({ lines, count }: Failure): string[] {
  const [headline, ...rest] = lines;
  if (count > 1) return [`${headline} (×${count})`, ...rest];
  return lines;
}

/** Each distinct failure in `lines`, in order; failures whose headlines differ only in numbers count as one. */
function findFailures(lines: string[]): Failure[] {
  const failures: Failure[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!MARKER.test(lines[index])) continue;
    const { block, next } = readFailure(lines, index);
    index = Math.max(index, next - 1);
    const key = block[0].replace(/\d+/g, "#");
    const same = failures.find((failure) => failure.key === key);
    if (same) same.count++;
    else failures.push({ key, lines: block, count: 1 });
  }
  return failures;
}

/**
 * The failure whose marker is at `start`: its headline, the error on the next line when the two are one failure, its
 * detail lines while the block has fewer than 5 lines, and its first in-repo frame, read until the next marker or 12
 * lines on. `next` is the first line not read.
 */
function readFailure(lines: string[], start: number) {
  const block = [lines[start].trim()];
  let frame = false;
  let next = start + 1;
  if (next < lines.length && isHeadlineError(lines[start], lines[next])) {
    block.push(`  ${lines[next].trim()}`);
    next++;
  }
  for (; next < lines.length && next <= start + 12 && !MARKER.test(lines[next]); next++) {
    if (DETAIL.test(lines[next]) && block.length < 5) block.push(`  ${lines[next].trim()}`);
    else if (!frame && isRepoFrame(lines[next])) {
      block.push(`  ${lines[next].trim()}`);
      frame = true;
    }
  }
  return { block, next };
}

/** A runner's headline ("FAIL a > b") and its error ("AssertionError: …") on adjacent lines are one failure. */
function isHeadlineError(line: string, nextLine: string) {
  return (
    MARKER.test(nextLine) &&
    line.trim().length + nextLine.length < 400 &&
    /^\s*(FAIL|✗|×)/.test(line) &&
    /Error/.test(nextLine)
  );
}

/** Whether `line` is a stack frame in the repo, not in a dependency or the runtime. */
function isRepoFrame(line: string) {
  return FRAME.test(line) && !/node_modules|node:internal|site-packages/.test(line);
}

/**
 * The output's lines worth reading: ANSI codes stripped, `root` made repo-relative, tabs expanded, and pass lines,
 * progress and blank lines dropped.
 */
function tailLines(output: string, root: string): string[] {
  // Windows output can hold root natively (`C:\r\repo`) or forward-slash; strip it and forward-slash the rest
  const rootRe = [root, normalisePath(root)].map(escapeRe).join("|");
  const lines = output
    // oxlint-disable-next-line no-control-regex -- ESC is intended: this strips ANSI escape codes
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(new RegExp(`(?:${rootRe})[\\\\/]([^\\s:'"\\[\\]()]*)`, "g"), (_, rest: string) =>
      rest.replace(/\\/g, "/"),
    )
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, "  ").trimEnd())
    .filter((l) => l.trim() && (MARKER.test(l) || !NOISE.test(l)));
  return lines;
}

/** Whether two tails show the same failure, ignoring numbers (timings, counts, ports). */
export const sameFailure = (a: string[], b: string[]) =>
  a.join("\n").replace(/\d+/g, "#") === b.join("\n").replace(/\d+/g, "#");

/** At most 200 chars, eliding the middle. */
const clip = (line: string) =>
  line.length <= 200 ? line : `${line.slice(0, 120)} … ${line.slice(-77)}`;

/** Escapes a string for literal use inside a RegExp. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
