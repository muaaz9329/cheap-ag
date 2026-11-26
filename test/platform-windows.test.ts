import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { killProcessGroup, link } from "../src/platform.js";

// The Windows branches call fs and child_process with Windows-only arguments; record the calls instead
const fakes = vi.hoisted(() => ({ spawnSync: vi.fn(), symlinkSync: vi.fn() }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: fakes.spawnSync };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, symlinkSync: fakes.symlinkSync };
});

afterEach(() => {
  fakes.spawnSync.mockReset();
  fakes.symlinkSync.mockReset();
});

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

test("link makes a junction on win32 and a dir symlink elsewhere", () => {
  onPlatform("win32", () => link("C:\\deps", "C:\\work\\deps"));
  expect(fakes.symlinkSync).toHaveBeenLastCalledWith("C:\\deps", "C:\\work\\deps", "junction");
  onPlatform("linux", () => link("/deps", "/work/deps"));
  expect(fakes.symlinkSync).toHaveBeenLastCalledWith("/deps", "/work/deps", "dir");
  onPlatform("darwin", () => link("/deps", "/work/deps"));
  expect(fakes.symlinkSync).toHaveBeenLastCalledWith("/deps", "/work/deps", "dir");
  expect(fakes.symlinkSync).toHaveBeenCalledTimes(3);
});

test("killProcessGroup on win32 runs taskkill on the whole tree, ignores the signal, and never calls process.kill", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  onTestFinished(() => kill.mockRestore());
  onPlatform("win32", () => killProcessGroup(4321, "SIGKILL"));
  onPlatform("win32", () => killProcessGroup(4321));
  const taskkill = [
    "taskkill",
    ["/pid", "4321", "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  ];
  expect(fakes.spawnSync.mock.calls).toEqual([taskkill, taskkill]);
  expect(kill).not.toHaveBeenCalled();
});

test("killProcessGroup on win32 does nothing without a pid", () => {
  onPlatform("win32", () => killProcessGroup(undefined));
  onPlatform("win32", () => killProcessGroup(0));
  expect(fakes.spawnSync).not.toHaveBeenCalled();
});
