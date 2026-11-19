import { describe, it, expect } from 'vitest';
import { formatInvoiceNumber, describeEvent } from './auditLog';

describe('formatInvoiceNumber', () => {
  it('pads to six digits with the FF prefix', () => {
    expect(formatInvoiceNumber(7)).toBe('FF-000007');
    expect(formatInvoiceNumber('123')).toBe('FF-000123');
    expect(formatInvoiceNumber(1234567)).toBe('FF-1234567');
  });
  it('is empty when there is no number yet', () => {
    expect(formatInvoiceNumber(null)).toBe('');
    expect(formatInvoiceNumber(undefined)).toBe('');
  });
});

describe('describeEvent', () => {
  it('describes status changes', () => {
    const e = { action: 'status_changed', changes: { status: { from: 'pending', to: 'completed' } } };
    expect(describeEvent(e).summary).toBe('changed status from pending to completed');
  });
  it('lists edited fields and line item counts', () => {
    const e = { action: 'updated', changes: {
      customer_name: { from: 'A', to: 'B' }, sales_rep_id: { from: 'x', to: 'y' }, sales_rep: { from: 'Amy', to: 'Bob' },
      items: { added: 2, removed: 1 }, po_number: { from: null, to: '42' } } };
    expect(describeEvent(e).details).toEqual([
      'Customer: A → B', 'Sales rep: Amy → Bob', 'Line items: 2 added, 1 removed', 'P.O. #: (empty) → 42',
    ]);
  });
  it('describes restores and deletions', () => {
    expect(describeEvent({ action: 'restored', changes: { invoices: 3, customers: 2 } }).details).toEqual(['3 invoices, 2 customers']);
    expect(describeEvent({ action: 'deleted', changes: { customer_name: 'Acme' } }).details).toEqual(['Customer: Acme']);
  });
  it('tolerates unknown actions and missing data', () => {
    expect(describeEvent({ action: 'weird' }).summary).toBe('weird');
    expect(describeEvent(undefined).summary).toBe('did something');
  });
});
