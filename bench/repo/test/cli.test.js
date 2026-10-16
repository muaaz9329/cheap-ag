import { test } from "node:test";
import assert from "node:assert/strict";
import { createInventory } from "../src/inventory.js";
import { run } from "../src/cli.js";

test("add then list and total", () => {
  const inv = createInventory();
  assert.equal(run(inv, ["add", "b1", "Bolt", "25", "4"]), "added b1");
  assert.equal(run(inv, ["list"]), "b1\tBolt\t25\t4");
  assert.equal(run(inv, ["total", "0.1"]), "110");
});

test("unknown commands fail", () => {
  assert.throws(() => run(createInventory(), ["nope"]), /unknown command/);
});
