import { spawn, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import {
  firstLine,
  gitBash,
  isAlive,
  killProcessGroup,
  link,
  normalisePath,
  opencodePlatform,
  removeLink,
  runCli,
  which,
} from "../src/platform.js";

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

/** Runs `run` with `process.platform` reading as `platform`, then puts the real value back. */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const errno = (code: string) => Object.assign(new Error(code), { code });

test("link makes a link at path that points to target; a path that already exists throws", () => {
  const d = tempDir();
  const target = join(d, "target");
  mkdirSync(target);
  writeFileSync(join(target, "file.txt"), "kept");
  link(target, join(d, "link"));
  expect(lstatSync(join(d, "link")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(d, "link", "file.txt"))).toBe(true);
  expect(() => link(target, join(d, "link"))).toThrow(expect.objectContaining({ code: "EEXIST" }));
});

test("removeLink removes the link, never what it points to, and leaves real files and folders alone", () => {
  const d = tempDir();
  const target = join(d, "target");
  mkdirSync(target);
  writeFileSync(join(target, "file.txt"), "kept");
  link(target, join(d, "link"));
  removeLink(join(d, "link"));
  expect(existsSync(join(d, "link"))).toBe(false);
  expect(existsSync(join(target, "file.txt"))).toBe(true);
  removeLink(target);
  removeLink(join(target, "file.txt"));
  expect(existsSync(join(target, "file.txt"))).toBe(true);
  expect(() => removeLink(join(d, "missing"))).not.toThrow();
});

test.skipIf(process.platform === "win32")("removeLink removes a link whose target is gone", () => {
  const d = tempDir();
  mkdirSync(join(d, "target"));
  link(join(d, "target"), join(d, "link"));
  rmSync(join(d, "target"), { recursive: true });
  expect(readlinkSync(join(d, "link"))).toBe(join(d, "target"));
  removeLink(join(d, "link"));
  expect(() => lstatSync(join(d, "link"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

test.skipIf(process.platform === "win32")(
  "normalisePath keeps a POSIX path as it is, backslashes included",
  () => {
    expect(normalisePath("src/a.ts")).toBe("src/a.ts");
    expect(normalisePath("odd\\name")).toBe("odd\\name");
  },
);

test.runIf(process.platform === "win32")(
  "normalisePath turns Windows separators into forward slashes",
  () => {
    expect(normalisePath("src\\dir\\a.ts")).toBe("src/dir/a.ts");
  },
);

test("isAlive is true for this process", () => {
  expect(isAlive(process.pid)).toBe(true);
});

test("isAlive: a process we can signal is alive, EPERM still counts as alive, any other error means gone", () => {
  const kill = vi.spyOn(process, "kill");
  onTestFinished(() => kill.mockRestore());
  kill.mockImplementation(() => true);
  expect(isAlive(4321)).toBe(true);
  expect(kill).toHaveBeenLastCalledWith(4321, 0);
  kill.mockImplementation(() => {
    throw errno("EPERM");
  });
  expect(isAlive(4321)).toBe(true);
  kill.mockImplementation(() => {
    throw errno("ESRCH");
  });
  expect(isAlive(4321)).toBe(false);
  kill.mockImplementation(() => {
    throw new Error("no code");
  });
  expect(isAlive(4321)).toBe(false);
});

test("opencodePlatform names Windows `windows` with opencode.exe, and any other OS by process.platform", () => {
  expect(onPlatform("win32", opencodePlatform)).toEqual({ os: "windows", binary: "opencode.exe" });
  expect(onPlatform("linux", opencodePlatform)).toEqual({ os: "linux", binary: "opencode" });
  expect(onPlatform("darwin", opencodePlatform)).toEqual({ os: "darwin", binary: "opencode" });
});

test("killProcessGroup off Windows signals the negative pid, SIGTERM by default, and swallows any error; pid 0 is a no-op", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  onTestFinished(() => kill.mockRestore());
  onPlatform("linux", () => killProcessGroup(4321, "SIGKILL"));
  expect(kill).toHaveBeenLastCalledWith(-4321, "SIGKILL");
  onPlatform("darwin", () => killProcessGroup(4321));
  expect(kill).toHaveBeenLastCalledWith(-4321, "SIGTERM");
  kill.mockClear();
  onPlatform("linux", () => killProcessGroup(0));
  expect(kill).not.toHaveBeenCalled();
  kill.mockImplementation(() => {
    throw errno("EPERM");
  });
  expect(onPlatform("linux", () => killProcessGroup(4321))).toBeUndefined();
});

test("which takes the first PATH directory that has a match", () => {
  const d = tempDir();
  for (const sub of ["a", "b"]) {
    mkdirSync(join(d, sub));
    writeFileSync(join(d, sub, "tool"), "");
  }
  const PATH = [join(d, "a"), join(d, "b")].join(delimiter);
  expect(which("tool", "linux", { PATH })).toBe(join(d, "a", "tool"));
});

test("which on win32 takes the first PATH directory with any match, before a preferred extension in a later one", () => {
  const d = tempDir();
  mkdirSync(join(d, "a"));
  mkdirSync(join(d, "b"));
  writeFileSync(join(d, "a", "tool.cmd"), "");
  writeFileSync(join(d, "b", "tool.exe"), "");
  const PATH = [join(d, "a"), join(d, "b")].join(delimiter);
  expect(which("tool", "win32", { PATH, PATHEXT: ".EXE;.CMD" })).toBe(join(d, "a", "tool.cmd"));
});

test("which on win32 skips a PATH directory it cannot read", () => {
  const d = tempDir();
  writeFileSync(join(d, "tool.exe"), "");
  const PATH = [join(d, "missing"), d].join(delimiter);
  expect(which("tool", "win32", { PATH, PATHEXT: ".EXE" })).toBe(join(d, "tool.exe"));
});

test("which on win32 ignores empty PATHEXT entries, so an extension still beats the bare name", () => {
  const d = tempDir();
  writeFileSync(join(d, "tool"), "");
  writeFileSync(join(d, "tool.exe"), "");
  expect(which("tool", "win32", { PATH: d, PATHEXT: ";.EXE;" })).toBe(join(d, "tool.exe"));
});

test("which ignores empty PATH entries, so it never looks in the current directory", () => {
  expect(existsSync("package.json")).toBe(true);
  expect(which("package.json", "linux", { PATH: delimiter })).toBeUndefined();
  expect(which("package.json", "win32", { PATH: delimiter })).toBeUndefined();
  expect(which("package.json", "linux", {})).toBeUndefined();
});

test("gitBash ignores CLAUDE_CODE_GIT_BASH_PATH off Windows; on Windows it trusts it without git on the PATH, and skips an empty one", () => {
  const { dir, bin, path } = gitInstall();
  const custom = join(dir, "custom-bash.exe");
  writeFileSync(custom, "");
  expect(gitBash("linux", { PATH: path, CLAUDE_CODE_GIT_BASH_PATH: custom })).toBeUndefined();
  expect(gitBash("win32", { CLAUDE_CODE_GIT_BASH_PATH: custom })).toBe(custom);
  expect(gitBash("win32", { PATH: path, CLAUDE_CODE_GIT_BASH_PATH: "" })).toBe(
    join(bin, "bash.exe"),
  );
});

const run = (output: Partial<SpawnSyncReturns<string>>) => output as SpawnSyncReturns<string>;

test("firstLine quotes the first line of the trimmed output, stderr before stdout, and an empty string for no run", () => {
  expect(firstLine(undefined)).toBe("");
  expect(firstLine(run({ stderr: "\n\n  error line  \nmore", stdout: "out" }))).toBe(
    "error line  ",
  );
  expect(firstLine(run({ stderr: "", stdout: "out one\nout two" }))).toBe("out one");
  expect(firstLine(run({ stderr: "", stdout: "" }))).toBe("");
  expect(firstLine(run({}))).toBe("");
});

test("firstLine: stderr that is only whitespace still wins over stdout, and a CRLF line keeps its \\r", () => {
  expect(firstLine(run({ stderr: " \n", stdout: "out" }))).toBe("");
  expect(firstLine(run({ stderr: "first\r\nsecond" }))).toBe("first\r");
});

const printArgs = '#!/bin/sh\nprintf "%s|%s|%s" "$1" "$2" "$3"\n';

/** Puts an executable script named `name` that prints its first three arguments on the PATH. */
function argPrinter(name: string) {
  const d = tempDir();
  writeFileSync(join(d, name), printArgs);
  chmodSync(join(d, name), 0o755);
  vi.stubEnv("PATH", `${d}${delimiter}${process.env.PATH}`);
  onTestFinished(() => void vi.unstubAllEnvs());
}

test.skipIf(process.platform === "win32")(
  "runCli spawns any other file directly, without a shell or quoting, with the caller's options",
  () => {
    argPrinter("cheapag-test-direct");
    vi.stubEnv("CHEAPAG_TEST_VALUE", "expanded");
    const r = runCli("cheapag-test-direct", ["two words", 'say "hi"', "$CHEAPAG_TEST_VALUE"], {
      encoding: "utf8",
    });
    expect(r?.status).toBe(0);
    expect(r?.stdout).toBe('two words|say "hi"|$CHEAPAG_TEST_VALUE');
    const raw = runCli("cheapag-test-direct", ["a"]);
    expect(Buffer.isBuffer(raw?.stdout)).toBe(true);
    expect(raw?.stdout.toString()).toBe("a||");
  },
);

test.skipIf(process.platform === "win32")(
  "runCli always sends a .BAT shim through a shell; arguments without spaces or quotes go in bare, and an empty one is lost",
  () => {
    argPrinter("cheapag-test.BAT");
    vi.stubEnv("CHEAPAG_TEST_VALUE", "expanded");
    const quoted = runCli("cheapag-test.BAT", ["$CHEAPAG_TEST_VALUE", 'a"b', "a\tb"], {
      encoding: "utf8",
      shell: false,
    });
    expect(quoted?.stdout).toBe('expanded|a"b|a\tb');
    const empty = runCli("cheapag-test.BAT", ["", "x"], { encoding: "utf8" });
    expect(empty?.stdout).toBe("x||");
  },
);
