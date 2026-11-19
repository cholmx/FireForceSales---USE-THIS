import { describe, it, expect } from 'vitest';
import { calculateTotals } from './invoiceMath';

describe('calculateTotals', () => {
  it('returns zeros for no items', () => {
    expect(calculateTotals([], 8, 0)).toEqual({ subtotal: 0, tax: 0, grandTotal: 0 });
  });

  it('taxes only taxable lines and adds shipping untaxed', () => {
    const items = [
      { qty: 2, unitPrice: 50, taxable: true },
      { qty: 1, unitPrice: 20, taxable: false },
    ];
    expect(calculateTotals(items, 10, 5)).toEqual({ subtotal: 120, tax: 10, grandTotal: 135 });
  });

  it('rounds each line to cents like the server', () => {
    const r = calculateTotals([{ qty: 3, unitPrice: 10.005, taxable: true }, { qty: 1, unitPrice: 20, taxable: false }], 10, 5);
    expect(r).toEqual({ subtotal: 50.02, tax: 3, grandTotal: 58.02 });
  });

  it('avoids floating point drift', () => {
    expect(calculateTotals([{ qty: 3, unitPrice: 0.1 }], 0, 0).subtotal).toBe(0.3);
  });

  it('treats missing taxable as taxable and bad numbers as zero', () => {
    const r = calculateTotals([{ qty: 'x', unitPrice: 5 }, { qty: 1, unitPrice: 100 }], 8, undefined);
    expect(r).toEqual({ subtotal: 100, tax: 8, grandTotal: 108 });
  });

  it('is zero tax for tax-exempt (all lines non-taxable)', () => {
    expect(calculateTotals([{ qty: 1, unitPrice: 100, taxable: false }], 8, 0).tax).toBe(0);
  });
});
