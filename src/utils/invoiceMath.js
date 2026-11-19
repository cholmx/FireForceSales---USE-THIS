// Mirrors public.ff_totals() in the database: each line is rounded to cents,
// tax applies to taxable lines only. The server recomputes totals on save.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function calculateTotals(items = [], taxRate = 0, shippingCost = 0) {
  let subtotal = 0;
  let taxable = 0;
  for (const item of items) {
    const line = round2(num(item.qty) * num(item.unitPrice));
    subtotal += line;
    if (item.taxable !== false) taxable += line;
  }
  subtotal = round2(subtotal);
  const tax = round2((taxable * num(taxRate)) / 100);
  const grandTotal = round2(subtotal + tax + num(shippingCost));
  return { subtotal, tax, grandTotal };
}
