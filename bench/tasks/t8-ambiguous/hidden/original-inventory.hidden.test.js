import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, createInventory, getItem, listItems, updateQty } from "../src/inventory.js";

test("add, get and list items", () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 10 });
  addItem(inv, { sku: "a1", name: "Anchor", price: 300, qty: 2 });
  assert.equal(getItem(inv, "b1").qty, 10);
  assert.deepEqual(listItems(inv).map((i) => i.sku), ["a1", "b1"]);
});

test("rejects duplicates and bad quantities", () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 1 });
  assert.throws(() => addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 1 }), /duplicate/);
  assert.throws(() => addItem(inv, { sku: "c1", name: "Clip", price: 5, qty: -1 }), /invalid qty/);
  assert.throws(() => updateQty(inv, "zz", 1), /not found/);
});

test("updateQty replaces the quantity", () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 1 });
  assert.equal(updateQty(inv, "b1", 7).qty, 7);
});
