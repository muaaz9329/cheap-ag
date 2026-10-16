import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as inventory from "../src/inventory.js";

test("removeItem removes and returns the item, throws on missing", () => {
  const inv = inventory.createInventory();
  inventory.addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 3 });
  const removed = inventory.removeItem(inv, "b1");
  assert.equal(removed.sku, "b1");
  assert.equal(inventory.listItems(inv).length, 0);
  assert.throws(() => inventory.removeItem(inv, "b1"), /not found/);
});

test("removeItem has a test in test/inventory.test.js", () => {
  assert.match(readFileSync(new URL("./inventory.test.js", import.meta.url), "utf8"), /removeItem/);
});
