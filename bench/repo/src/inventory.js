/** An inventory is a map from SKU to item. Items have { sku, name, price (cents), qty }. */
export function createInventory() {
  return { items: new Map() };
}

export function addItem(inv, { sku, name, price, qty }) {
  if (inv.items.has(sku)) throw new Error(`duplicate sku: ${sku}`);
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`invalid qty for ${sku}: ${qty}`);
  const item = { sku, name, price, qty };
  inv.items.set(sku, item);
  return item;
}

export function getItem(inv, sku) {
  const item = inv.items.get(sku);
  if (!item) throw new Error(`not found: ${sku}`);
  return item;
}

export function updateQty(inv, sku, qty) {
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`invalid qty for ${sku}: ${qty}`);
  const item = getItem(inv, sku);
  item.qty = qty;
  return item;
}

export function listItems(inv) {
  return [...inv.items.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}
