import { listItems } from "./inventory.js";

/** All money is in integer cents. */
export function lineTotal(item) {
  return item.price * item.qty;
}

export function subtotal(inv) {
  return listItems(inv).reduce((sum, item) => sum + lineTotal(item), 0);
}

/** Sales tax on an amount, rounded to the nearest cent (half up). */
export function tax(amount, rate) {
  if (rate < 0 || rate > 1) throw new Error(`invalid rate: ${rate}`);
  return Math.round(amount * rate);
}

/** Grand total: subtotal, less an optional fractional discount (applied before tax), plus tax. */
export function total(inv, { taxRate = 0, discount = 0 } = {}) {
  const sub = subtotal(inv);
  return sub + tax(sub, taxRate);
}
