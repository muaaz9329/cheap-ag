import { listItems } from "./inventory.js";
import { lineTotal, subtotal, tax, total } from "./pricing.js";

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** A plain-text receipt: one line per item, then subtotal, tax and total. Returns the lines joined by "\n". */
export function formatReceipt(inv, { taxRate = 0, width = 32 } = {}) {
  const lines = listItems(inv).map((item) => {
    const left = `${item.qty} x ${item.name}`;
    const right = money(lineTotal(item));
    return left.padEnd(width - right.length) + right;
  });
  const sub = subtotal(inv);
  lines.push("-".repeat(width));
  lines.push("Subtotal".padEnd(width - money(sub).length) + money(sub));
  lines.push("Tax".padEnd(width - money(tax(sub, taxRate)).length) + money(tax(sub, taxRate)));
  lines.push("Total".padEnd(width - money(total(inv, { taxRate })).length) + money(total(inv, { taxRate })));
  return lines.join("\n");
}
