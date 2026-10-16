import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("test/receipt.test.js exists, has at least 4 tests, and they all pass", () => {
  const file = new URL("./receipt.test.js", import.meta.url);
  assert.ok(existsSync(file), "test/receipt.test.js is missing");
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file.pathname], { encoding: "utf8" });
  const ok = (r.stdout.match(/^ok \d+/gm) || []).length;
  assert.equal((r.stdout.match(/^not ok/gm) || []).length, 0, r.stdout);
  assert.ok(ok >= 4, `only ${ok} passing tests`);
});
