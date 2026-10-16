import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, createInventory } from "../src/inventory.js";
import { total } from "../src/pricing.js";

test("discount applies before tax, rounded to the cent", () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 333, qty: 1 }); // 333
  assert.equal(total(inv, { discount: 0.1, taxRate: 0 }), 300); // 299.7 -> 300
  assert.equal(total(inv, { discount: 0.1, taxRate: 0.1 }), 330); // 300 + 30
  assert.equal(total(inv, { taxRate: 0.1 }), 366); // unchanged without a discount
});
