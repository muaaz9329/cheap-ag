import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { gitBash, isAlive, killProcessGroup, runCli, which } from "../src/platform.js";

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

// Git for Windows layout: git.exe in <Git>\cmd, bash.exe in <Git>\bin
const gitInstall = (withBash = true) => {
  const d = tempDir();
  const cmd = join(d, "Git", "cmd");
  const bin = join(d, "Git", "bin");
  mkdirSync(cmd, { recursive: true });
  writeFileSync(join(cmd, "git.exe"), "");
  if (withBash) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "bash.exe"), "");
  }
  return { dir: d, bin, path: cmd };
};

test("gitBash is undefined off Windows", () => {
  expect(gitBash("darwin", { PATH: "/usr/bin" })).toBeUndefined();
});

test("gitBash derives Git for Windows' bash.exe from git on the PATH", () => {
  const { bin, path } = gitInstall();
  expect(gitBash("win32", { PATH: path })).toBe(join(bin, "bash.exe"));
});

test("gitBash prefers CLAUDE_CODE_GIT_BASH_PATH when it exists", () => {
  const { dir, bin, path } = gitInstall();
  writeFileSync(join(dir, "custom-bash.exe"), "");
  expect(
    gitBash("win32", { PATH: path, CLAUDE_CODE_GIT_BASH_PATH: join(dir, "custom-bash.exe") }),
  ).toBe(join(dir, "custom-bash.exe"));
  // a stale override that is not there falls back to the derived path
  expect(gitBash("win32", { PATH: path, CLAUDE_CODE_GIT_BASH_PATH: join(dir, "gone.exe") })).toBe(
    join(bin, "bash.exe"),
  );
});

test("gitBash is undefined when git or its bash.exe is missing", () => {
  const { path } = gitInstall(false);
  expect(gitBash("win32", { PATH: path })).toBeUndefined();
  expect(gitBash("win32", { PATH: join(tempDir(), "Git", "cmd") })).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "runCli runs a .cmd shim through a shell, with arguments that hold spaces or quotes kept whole",
  () => {
    const d = tempDir();
    writeFileSync(join(d, "shim.cmd"), '#!/bin/sh\nprintf "%s|%s|%s" "$1" "$2" "$3"\n');
    chmodSync(join(d, "shim.cmd"), 0o755);
    vi.stubEnv("PATH", `${d}:${process.env.PATH}`);
    onTestFinished(() => void vi.unstubAllEnvs());
    const r = runCli("shim.cmd", ["plain", "two words", 'say "hi"'], { encoding: "utf8" });
    expect(r?.status).toBe(0);
    expect(r?.stdout).toBe('plain|two words|say "hi"');
  },
);

test.skipIf(process.platform === "win32")(
  "killProcessGroup: signals the group; on win32 it hands over to taskkill and never signals; no pid is a no-op",
  async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    onTestFinished(() => void child.kill("SIGKILL"));
    const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    expect(killProcessGroup(undefined)).toBeUndefined();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      killProcessGroup(child.pid); // taskkill does not exist here: nothing happens, and nothing throws
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(isAlive(child.pid!)).toBe(true);
    killProcessGroup(child.pid);
    expect(await exited).toBe("SIGTERM");
    killProcessGroup(child.pid); // already gone: ignored
  },
);
