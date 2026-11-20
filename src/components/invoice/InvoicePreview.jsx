import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useReactToPrint } from 'react-to-print';
import { formatInvoiceNumber } from '../../utils/auditLog';
import SafeIcon from '../../common/SafeIcon';
import * as FiIcons from 'react-icons/fi';

const { FiX, FiPrinter } = FiIcons;

// The logo lives in /public so it can be swapped without touching code. If the file is missing the
// header falls back to a clean text wordmark.
const LOGO_PATH = '/fireforce-logo.png';

// Each document type gets its own accent color, used for the small badge, the rule under the header
// and the grand total, so a printed page is recognisable at a glance without a big stamp.
const TYPE_STYLES = {
  'Sales Order': { color: '#C81E1E', tint: '#FDECEC' },
  'Service Order': { color: '#15803D', tint: '#E8F5EC' },
  Quote: { color: '#B45309', tint: '#FEF3E2' },
};
const DEFAULT_TYPE_STYLE = { color: '#374151', tint: '#F1F2F4' };
export const typeStyle = (type) => TYPE_STYLES[type] || DEFAULT_TYPE_STYLE;

const money = (n) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const officeInfo = {
  companyName: 'Fire Force',
  tagline: 'Fire Safety Equipment Sales & Service',
  address: 'P.O. Box 552, Columbiana, Ohio 44408',
  website: 'fforce.com',
  ohPhone: '330-482-9300',
  ohEmail: 'Lizfireforce@yahoo.com',
  paEmail: 'fireforcebutler@gmail.com',
};

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';

const Label = ({ children }) => (
  <div style={{ fontSize: '8.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: MUTED, marginBottom: '5px' }}>
    {children}
  </div>
);

const th = (align = 'left') => ({
  textAlign: align,
  padding: '7px 8px',
  fontSize: '8.5px',
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: MUTED,
  borderBottom: `1.5px solid ${INK}`,
  backgroundColor: '#F9FAFB',
});
const td = (align = 'left', extra = {}) => ({
  textAlign: align,
  padding: '7px 8px',
  fontSize: '10px',
  color: INK,
  borderBottom: `1px solid ${LINE}`,
  verticalAlign: 'top',
  ...extra,
});

const InvoicePreview = ({ invoiceData, onClose }) => {
  const componentRef = useRef();
  const [logoUrl, setLogoUrl] = useState(null);

  // Use an absolute URL (printing renders into an iframe) and only show the logo once we know it loads.
  useEffect(() => {
    const url = new URL(LOGO_PATH, window.location.origin).href;
    const img = new Image();
    img.onload = () => setLogoUrl(url);
    img.onerror = () => setLogoUrl(null);
    img.src = url;
  }, []);

  const type = invoiceData.transactionType || 'Sales Order';
  const accent = typeStyle(type);
  const items = invoiceData.items || [];
  const invoiceNo = formatInvoiceNumber(invoiceData.invoiceNumber);
  const dateText = invoiceData.date ? new Date(`${invoiceData.date}T00:00:00`).toLocaleDateString() : '';

  const getDocumentTitle = () => `Fire Force ${type} - ${invoiceNo || invoiceData.poNumber || 'Draft'}`;

  const handlePrint = useReactToPrint({
    content: () => componentRef.current,
    documentTitle: getDocumentTitle(),
    pageStyle: `
      @page { size: 8.5in 11in; margin: 0.5in; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @media print {
        body { font-family: ${FONT}; color: #000; }
        .print-page { width: 7.5in; margin: 0 auto; background: white; box-shadow: none !important; padding: 0 !important; }
        tr { page-break-inside: avoid; }
        thead { display: table-header-group; }
      }
    `,
  });

  const contactLine = (label, value) =>
    value ? (
      <div style={{ marginBottom: '2px' }}>
        <span style={{ color: MUTED }}>{label} </span>
        {value}
      </div>
    ) : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div className="flex justify-between items-center p-5 border-b border-gray-200">
          <h2 className="text-lg font-title font-bold text-gray-900">{type} Preview</h2>
          <div className="flex space-x-3">
            <button
              onClick={handlePrint}
              className="flex items-center space-x-2 px-4 py-2 bg-brand-gradient hover:bg-brand-gradient-hover text-white rounded-lg transition-all duration-300"
            >
              <SafeIcon icon={FiPrinter} />
              <span>Print</span>
            </button>
            <button onClick={onClose} className="flex items-center space-x-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700">
              <SafeIcon icon={FiX} />
              <span>Close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-gray-100">
          <div ref={componentRef} className="print-page bg-white mx-auto shadow-lg" style={{ padding: '36px 40px', maxWidth: '8in' }}>
            <div style={{ fontFamily: FONT, fontSize: '10px', lineHeight: 1.45, color: INK, width: '100%' }}>
              {/* ── Header: logo + company on the left, document identity on the right ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  {logoUrl && (
                    <img src={logoUrl} alt="Fire Force" style={{ width: '84px', height: '84px', objectFit: 'contain', display: 'block' }} />
                  )}
                  <div>
                    <div style={{ fontSize: logoUrl ? '17px' : '26px', fontWeight: 800, letterSpacing: '0.02em', color: INK, lineHeight: 1.1 }}>
                      {officeInfo.companyName.toUpperCase()}
                    </div>
                    <div style={{ fontSize: '9.5px', color: MUTED, marginTop: '2px', marginBottom: '6px' }}>{officeInfo.tagline}</div>
                    <div style={{ fontSize: '9px', color: MUTED, lineHeight: 1.5 }}>
                      {officeInfo.address}
                      <br />
                      OH {officeInfo.ohPhone} · {officeInfo.ohEmail}
                      <br />
                      PA {officeInfo.paEmail}
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: 'right', minWidth: '180px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '3px 10px',
                      borderRadius: '999px',
                      fontSize: '9px',
                      fontWeight: 800,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      color: accent.color,
                      backgroundColor: accent.tint,
                      border: `1px solid ${accent.color}`,
                    }}
                  >
                    {type}
                  </span>
                  {invoiceNo && <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '8px', letterSpacing: '0.01em' }}>{invoiceNo}</div>}
                  <div style={{ marginTop: invoiceNo ? '6px' : '10px', fontSize: '9.5px', lineHeight: 1.7 }}>
                    <div><span style={{ color: MUTED }}>Date </span><strong>{dateText}</strong></div>
                    <div><span style={{ color: MUTED }}>P.O. # </span><strong>{invoiceData.poNumber || 'N/A'}</strong></div>
                    <div><span style={{ color: MUTED }}>Sales rep </span><strong>{invoiceData.salesRep}</strong></div>
                  </div>
                </div>
              </div>

              <div style={{ height: '3px', backgroundColor: accent.color, margin: '16px 0 18px', borderRadius: '2px' }} />

              {/* ── Customer / Bill to / Ship to ── */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
                <div style={{ flex: 1.1 }}>
                  <Label>Customer</Label>
                  <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: '2px' }}>{invoiceData.customerName}</div>
                  {invoiceData.company && <div style={{ marginBottom: '2px' }}>{invoiceData.company}</div>}
                  {contactLine('Email', invoiceData.customerEmail)}
                  {contactLine('Phone', invoiceData.customerPhone)}
                  {contactLine('A/P', invoiceData.accountsPayableEmail)}
                </div>
                <div style={{ flex: 1, backgroundColor: '#F9FAFB', border: `1px solid ${LINE}`, borderRadius: '6px', padding: '10px 12px' }}>
                  <Label>Bill to</Label>
                  <div style={{ whiteSpace: 'pre-line', minHeight: '38px' }}>{invoiceData.billToAddress}</div>
                </div>
                <div style={{ flex: 1, backgroundColor: '#F9FAFB', border: `1px solid ${LINE}`, borderRadius: '6px', padding: '10px 12px' }}>
                  <Label>Ship to</Label>
                  <div style={{ whiteSpace: 'pre-line', minHeight: '38px' }}>{invoiceData.shipToAddress}</div>
                </div>
              </div>

              {/* ── Line items ── */}
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '16px' }}>
                <thead>
                  <tr>
                    <th style={th()}>MFG</th>
                    <th style={th()}>Part #</th>
                    <th style={{ ...th(), width: '38%' }}>Description</th>
                    <th style={th('center')}>Qty</th>
                    <th style={th('right')}>Unit price</th>
                    <th style={th('center')}>Tax</th>
                    <th style={th('right')}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={index}>
                      <td style={td()}>{item.mfg}</td>
                      <td style={td()}>{item.partNumber}</td>
                      <td style={td()}>{item.description}</td>
                      <td style={td('center')}>{item.qty}</td>
                      <td style={td('right', { fontVariantNumeric: 'tabular-nums' })}>{money(item.unitPrice)}</td>
                      <td style={td('center', { color: MUTED })}>{item.taxable ? '✓' : '—'}</td>
                      <td style={td('right', { fontWeight: 700, fontVariantNumeric: 'tabular-nums' })}>{money((Number(item.qty) || 0) * (Number(item.unitPrice) || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* ── Totals ── */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '20px', pageBreakInside: 'avoid' }}>
                <div style={{ width: '240px', fontSize: '10px' }}>
                  {[
                    ['Subtotal', money(invoiceData.subtotal)],
                    [`Tax (${invoiceData.taxRate ?? 0}%)`, money(invoiceData.tax)],
                    ['Shipping', money(invoiceData.shippingCost)],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', borderBottom: `1px solid ${LINE}` }}>
                      <span style={{ color: MUTED }}>{label}</span>
                      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                    </div>
                  ))}
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      padding: '9px 8px', marginTop: '4px', backgroundColor: accent.tint,
                      borderTop: `2px solid ${accent.color}`, borderRadius: '0 0 4px 4px',
                    }}
                  >
                    <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent.color }}>Total</span>
                    <span style={{ fontSize: '15px', fontWeight: 800, color: INK, fontVariantNumeric: 'tabular-nums' }}>{money(invoiceData.grandTotal)}</span>
                  </div>
                </div>
              </div>

              {/* ── Notes ── */}
              {invoiceData.additionalInfo && (
                <div style={{ marginBottom: '18px', pageBreakInside: 'avoid' }}>
                  <Label>Notes</Label>
                  <div style={{ whiteSpace: 'pre-line', padding: '9px 12px', backgroundColor: '#F9FAFB', border: `1px solid ${LINE}`, borderRadius: '6px' }}>
                    {invoiceData.additionalInfo}
                  </div>
                </div>
              )}

              {/* ── Footer ── */}
              <div style={{ marginTop: '22px', paddingTop: '10px', borderTop: `1px solid ${LINE}`, textAlign: 'center', fontSize: '9px', color: MUTED }}>
                <strong style={{ color: INK }}>Thank you for your business.</strong>{' '}
                Questions about this {type.toLowerCase()}? Call {officeInfo.ohPhone} or visit {officeInfo.website}.
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default InvoicePreview;
