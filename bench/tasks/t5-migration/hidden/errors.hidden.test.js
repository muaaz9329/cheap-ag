import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { InventoryError } from "../src/errors.js";
import { addItem, createInventory, getItem } from "../src/inventory.js";
import { tax } from "../src/pricing.js";
import { run } from "../src/cli.js";

const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof InventoryError, `not an InventoryError: ${e}`); return e.code; } assert.fail("did not throw"); };

test("every module throws InventoryError with the right code", () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 1, qty: 1 });
  assert.equal(code(() => getItem(inv, "zz")), "NOT_FOUND");
  assert.equal(code(() => addItem(inv, { sku: "b1", name: "Bolt", price: 1, qty: 1 })), "DUPLICATE_SKU");
  assert.equal(code(() => addItem(inv, { sku: "c1", name: "Clip", price: 1, qty: -1 })), "INVALID_QTY");
  assert.equal(code(() => tax(1, 2)), "INVALID_RATE");
  assert.equal(code(() => run(inv, ["add", "x"])), "USAGE");
  assert.equal(code(() => run(inv, ["nope"])), "UNKNOWN_COMMAND");
});

test("no plain `new Error(` remains under src/", () => {
  for (const f of readdirSync(new URL("../src/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), /new Error\(/, `src/${f}`);
  }
});
