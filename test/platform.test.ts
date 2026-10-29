import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCli, which } from "../src/platform.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "cheapag-which-")));

test("which finds a file on the PATH", () => {
  const d = tempDir();
  writeFileSync(join(d, "my-tool"), "");
  expect(which("my-tool", "linux", { PATH: d })).toBe(join(d, "my-tool"));
});

test("which on win32 tries PATHEXT in order", () => {
  const d = tempDir();
  writeFileSync(join(d, "tool.exe"), "");
  writeFileSync(join(d, "tool.cmd"), "");
  expect(which("tool", "win32", { PATH: d, PATHEXT: ".EXE;.CMD" })).toBe(join(d, "tool.exe"));
  expect(which("tool", "win32", { PATH: d, PATHEXT: ".CMD;.EXE" })).toBe(join(d, "tool.cmd"));
  expect(which("tool", "win32", { PATH: d })).toBe(join(d, "tool.exe")); // default PATHEXT, .EXE before .CMD
});

test("which on win32 matches extensions case-insensitively and tries the bare name last", () => {
  const d = tempDir();
  writeFileSync(join(d, "tool.CMD"), "");
  writeFileSync(join(d, "bare"), "");
  expect(which("tool", "win32", { PATH: d, PATHEXT: ".cmd" })).toBe(join(d, "tool.CMD"));
  expect(which("bare", "win32", { PATH: d, PATHEXT: ".EXE" })).toBe(join(d, "bare"));
});

test("which returns undefined when nothing matches", () => {
  const d = tempDir();
  expect(which("nope", "linux", { PATH: d })).toBeUndefined();
  expect(which("nope", "win32", { PATH: d, PATHEXT: ".EXE" })).toBeUndefined();
});

test("runCli returns undefined for a command that is not on the PATH", () => {
  expect(runCli("definitely-not-a-cheapag-test-command", [])).toBeUndefined();
});
