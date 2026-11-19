// Formatting helpers for invoice numbers and audit-trail events.
export const formatInvoiceNumber = (n) =>
  n === null || n === undefined || n === '' ? '' : `FF-${String(n).padStart(6, '0')}`;

const FIELD_LABELS = {
  date: 'Date', po_number: 'P.O. #', sales_rep: 'Sales rep', sales_rep_id: 'Sales rep',
  transaction_type: 'Type', customer_name: 'Customer', company: 'Company',
  customer_email: 'Customer email', customer_phone: 'Customer phone',
  accounts_payable_email: 'A/P email', bill_to_address: 'Bill-to address', ship_to_address: 'Ship-to address',
  shipping_cost: 'Shipping', additional_info: 'Notes', status: 'Status', tax_rate: 'Tax rate',
  subtotal: 'Subtotal', tax: 'Tax', grand_total: 'Total', archived: 'Archived',
};

const show = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

// Returns { summary, details[] } for one invoice_events row.
export function describeEvent(event) {
  const c = event?.changes || {};
  switch (event?.action) {
    case 'created':
      return { summary: 'created the invoice', details: [] };
    case 'deleted':
      return { summary: 'deleted the invoice', details: c.customer_name ? [`Customer: ${c.customer_name}`] : [] };
    case 'archived':
      return { summary: 'archived the invoice', details: [] };
    case 'unarchived':
      return { summary: 'restored the invoice from the archive', details: [] };
    case 'status_changed':
      return { summary: `changed status from ${show(c.status?.from)} to ${show(c.status?.to)}`, details: [] };
    case 'restored':
      return {
        summary: 'restored a backup',
        details: [`${c.invoices ?? 0} invoices, ${c.customers ?? 0} customers`],
      };
    case 'updated': {
      const details = [];
      const seen = new Set();
      for (const [key, val] of Object.entries(c)) {
        if (key === 'items') {
          details.push(`Line items: ${val.added ?? 0} added, ${val.removed ?? 0} removed`);
        } else if (key === 'sales_rep_id') {
          continue; // shown via the readable sales_rep name
        } else {
          const label = FIELD_LABELS[key] || key;
          if (seen.has(label)) continue;
          seen.add(label);
          details.push(`${label}: ${show(val?.from)} → ${show(val?.to)}`);
        }
      }
      return { summary: 'edited the invoice', details };
    }
    default:
      return { summary: String(event?.action || 'did something'), details: [] };
  }
}
