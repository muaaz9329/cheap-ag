import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as inventory from "../src/inventory.js";
import { run } from "../src/cli.js";

test("items use quantity and updateQuantity exists", () => {
  const inv = inventory.createInventory();
  const item = inventory.addItem(inv, { sku: "b1", name: "Bolt", price: 25, quantity: 2 });
  assert.equal(item.quantity, 2);
  assert.equal("qty" in item, false);
  assert.equal(inventory.updateQuantity(inv, "b1", 5).quantity, 5);
  assert.equal(run(inv, ["list"]), "b1\tBolt\t25\t5");
});

test("no `qty` remains under src/ or test/ (hidden tests excluded)", () => {
  for (const dir of ["src", "test"]) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (f.includes(".hidden.")) continue;
      assert.doesNotMatch(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8"), /qty/i, `${dir}/${f}`);
    }
  }
});
