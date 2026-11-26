import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { withLock } from "../src/workspace.js";
import { tempRepo } from "./harness.js";

/** What another process does in the instant before this one renames a stale lock away. */
const race = vi.hoisted(() => ({ before: undefined as ((lock: string) => void) | undefined }));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: ((from: string, to: string) => {
      const before = race.before;
      race.before = undefined;
      if (before && String(from).endsWith("land.lock")) before(String(from));
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const DEAD = JSON.stringify({
  pid: 2 ** 22 + 12345,
  at: "2026-01-01T00:00:00.000Z",
  token: "dead",
}); // no such process

function staleLock() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const dir = join(repo.dir, ".cheapag");
  mkdirSync(dir);
  const lock = join(dir, "land.lock");
  writeFileSync(lock, DEAD);
  return {
    root: repo.dir,
    lock,
    leftovers: () => readdirSync(dir).filter((name) => name !== "land.lock"),
  };
}

test("a dead holder's lock is broken and taken", async () => {
  const { root, lock, leftovers } = staleLock();
  expect(await withLock(root, () => JSON.parse(readFileSync(lock, "utf8")).pid)).toBe(process.pid);
  expect(leftovers()).toEqual([]);
});

test("another waiter breaking the stale lock first is not an error: this one just takes the freed lock", async () => {
  const { root, lock, leftovers } = staleLock();
  race.before = (file) => rmSync(file); // gone before our rename
  expect(await withLock(root, () => JSON.parse(readFileSync(lock, "utf8")).pid)).toBe(process.pid);
  expect(leftovers()).toEqual([]);
});

test("a live process that took the lock between the check and the break gets it back, and this waiter keeps waiting", async () => {
  const { root, lock, leftovers } = staleLock();
  const live = JSON.stringify({ pid: process.pid, at: "2026-11-26T00:00:00.000Z", token: "live" });
  race.before = (file) => writeFileSync(file, live); // another waiter broke it and a live process holds it now
  vi.stubEnv("CHEAPAG_LOCK_TIMEOUT_MS", "300");
  onTestFinished(() => void vi.unstubAllEnvs());
  const ran = vi.fn();
  await expect(withLock(root, ran)).rejects.toThrow(
    `timed out after 0.3 s waiting for .cheapag/land.lock (held by pid ${process.pid} since 2026-11-26T00:00:00.000Z); try again once it is released`,
  );
  expect(ran).not.toHaveBeenCalled();
  expect(readFileSync(lock, "utf8")).toBe(live); // put back, untouched
  expect(leftovers()).toEqual([]);
});
