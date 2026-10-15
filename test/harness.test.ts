import { existsSync } from "node:fs";
import { expect, onTestFinished, test } from "vitest";
import { tempRepo } from "./harness.js";

test.each([
  ["clean", ""],
  ["dirty", " M README.md\n"],
  ["untracked", "?? notes.txt\n"],
] as const)("tempRepo(%s) yields that working-tree state and cleans up", (state, porcelain) => {
  const repo = tempRepo(state);
  onTestFinished(repo.cleanup);
  expect(repo.git("status", "--porcelain")).toBe(porcelain);
  expect(repo.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  repo.cleanup();
  expect(existsSync(repo.dir)).toBe(false);
});
