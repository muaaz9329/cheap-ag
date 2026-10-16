import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, createInventory } from "../src/inventory.js";
import { subtotal, tax, total } from "../src/pricing.js";

const stocked = () => {
  const inv = createInventory();
  addItem(inv, { sku: "b1", name: "Bolt", price: 25, qty: 4 }); // 100
  addItem(inv, { sku: "a1", name: "Anchor", price: 300, qty: 1 }); // 300
  return inv;
};

test("subtotal sums line totals", () => assert.equal(subtotal(stocked()), 400));
test("tax rounds half up to the cent", () => {
  assert.equal(tax(400, 0.0825), 33);
  assert.equal(tax(101, 0.5), 51);
  assert.throws(() => tax(1, 2), /invalid rate/);
});
test("total adds tax", () => assert.equal(total(stocked(), { taxRate: 0.1 }), 440));
