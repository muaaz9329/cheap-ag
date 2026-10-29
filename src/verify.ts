import { spawn } from "node:child_process";
import { killProcessGroup } from "./platform.js";

/** Verify: runs a job's executable done conditions in its worktree and condenses failures into an error tail. */

export type VerifyRun = { cmd: string; ok: boolean; ms: number; output: string };

// a backstop per command; the job's minute cap (its `signal`) bounds the whole job
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;

/** The backticked fragments of each step's `done-when`, in order; else the configured test_cmd; else none. */
export function verifyCommands(doneWhen: string[], testCmd?: string) {
  const backticked = doneWhen.flatMap((text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())).filter(Boolean);
  return backticked.length ? backticked : testCmd ? [testCmd] : [];
}

/**
 * Runs the commands in order in `cwd`, stopping at the first failure; `onStart` hears each command as it begins.
 * Aborting `signal` kills the running command's process group (cap or cancel) and fails it.
 */
export async function runVerify(cwd: string, cmds: string[], onStart: (cmd: string) => void, signal?: AbortSignal): Promise<VerifyRun[]> {
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

function runOne(cwd: string, cmd: string, signal?: AbortSignal): Promise<VerifyRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    // its own process group, so everything it spawned can be stopped with it; shell form: /bin/sh -c on POSIX, cmd.exe on Windows
    const child = spawn(cmd, { shell: true, cwd, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    const killGroup = () => killProcessGroup(child.pid, "SIGKILL");
    let output = "";
    let code: number | null = null;
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
    child.on("exit", (exitCode) => {
      code = exitCode;
      killGroup();
    });
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", halt);
      resolve({ cmd, ok: code === 0 && !signal?.aborted, ms: Date.now() - started, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", halt);
      resolve({ cmd, ok: false, ms: Date.now() - started, output: err.message });
    });
  });
}

const MARKER = /✗|✘|×|\bFAIL\b|Error:|error TS\d+|AssertionError|Traceback|panicked|^E\s{2,}/;
const DETAIL = /expected|received|\bgot\b|\bwant\b|^\s*[-+] /i;
const FRAME = /^\s*(at |File ")|\.(ts|tsx|js|mjs|cjs|py|go|rs):\d+/;
// pass lines and progress only: a line that also carries a failure marker is never noise
const NOISE = /^\s*(✓|√|PASS\b|ok\b)|^\s*(Tests?|Test Files|Suites?)\b.*\bpassed\b|^\s*[.·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/;
const MAX_FAILURES = 3;
const MAX_LINES = 25;

/**
 * Spec D9: the failing command, then up to 3 distinct failures (similar ones counted ×N), each with its message,
 * expected/received lines and first in-repo frame; at most 25 lines of 200 chars, with `root` made repo-relative.
 * Falls back to the last lines when no failure marker is found.
 */
export function errorTail(run: VerifyRun, root: string): string[] {
  const lines = run.output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(`${root}/`).join("")
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, "  ").trimEnd())
    .filter((l) => l.trim() && (MARKER.test(l) || !NOISE.test(l)));

  const failures: { key: string; lines: string[]; count: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!MARKER.test(lines[i])) continue;
    const block = [lines[i].trim()];
    let frame = false;
    let j = i + 1;
    // a runner's headline ("FAIL a > b") and its error ("AssertionError: …") on adjacent lines are one failure
    if (j < lines.length && MARKER.test(lines[j]) && block[0].length + lines[j].length < 400 && /^\s*(FAIL|✗|×)/.test(lines[i]) && /Error/.test(lines[j])) {
      block.push(`  ${lines[j].trim()}`);
      j++;
    }
    for (; j < lines.length && j <= i + 12 && !MARKER.test(lines[j]); j++) {
      if (DETAIL.test(lines[j]) && block.length < 5) block.push(`  ${lines[j].trim()}`);
      else if (!frame && FRAME.test(lines[j]) && !/node_modules|node:internal|site-packages/.test(lines[j])) {
        block.push(`  ${lines[j].trim()}`);
        frame = true;
      }
    }
    i = Math.max(i, j - 1);
    const key = block[0].replace(/\d+/g, "#");
    const same = failures.find((f) => f.key === key);
    if (same) same.count++;
    else failures.push({ key, lines: block, count: 1 });
  }

  const body = failures.length
    ? failures.slice(0, MAX_FAILURES).flatMap((f) => [f.count > 1 ? `${f.lines[0]} (×${f.count})` : f.lines[0], ...f.lines.slice(1)])
    : lines.slice(-(MAX_LINES - 1));
  return [`\`${run.cmd}\``, ...body.slice(0, MAX_LINES - 1).map((l) => clip(`  ${l}`))];
}

/** Whether two tails show the same failure, ignoring numbers (timings, counts, ports). */
export const sameFailure = (a: string[], b: string[]) => a.join("\n").replace(/\d+/g, "#") === b.join("\n").replace(/\d+/g, "#");

/** At most 200 chars, eliding the middle. */
const clip = (line: string) => (line.length <= 200 ? line : `${line.slice(0, 120)} … ${line.slice(-77)}`);
