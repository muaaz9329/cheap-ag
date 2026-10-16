import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("README documents the CLI commands with examples, and keeps the old content", () => {
  const md = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(md, /^## CLI/m);
  for (const cmd of ["add", "list", "total", "receipt"]) assert.match(md, new RegExp(`\`${cmd}`), `command ${cmd} missing`);
  assert.match(md, /node src\/cli\.js/);
  assert.match(md, /npm test/);
});
