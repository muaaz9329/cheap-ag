#!/usr/bin/env node
import { addItem, createInventory, listItems } from "./inventory.js";
import { total } from "./pricing.js";
import { formatReceipt } from "./receipt.js";

/** Runs one command against an inventory and returns the text to print. Commands: add, list, total, receipt. */
export function run(inv, argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "add": {
      const [sku, name, price, qty] = args;
      if (!sku || !name || !price || !qty) throw new Error("usage: add <sku> <name> <price-cents> <qty>");
      addItem(inv, { sku, name, price: Number(price), qty: Number(qty) });
      return `added ${sku}`;
    }
    case "list":
      return listItems(inv).map((i) => `${i.sku}\t${i.name}\t${i.price}\t${i.qty}`).join("\n");
    case "total":
      return String(total(inv, { taxRate: Number(args[0] ?? 0) }));
    case "receipt":
      return formatReceipt(inv, { taxRate: Number(args[0] ?? 0) });
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(run(createInventory(), process.argv.slice(2)));
}
