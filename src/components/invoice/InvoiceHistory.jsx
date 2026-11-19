import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import supabase from '../../lib/supabase';
import { describeEvent, formatInvoiceNumber } from '../../utils/auditLog';

export const EventList = ({ events, showInvoice = false }) => (
  <ul className="divide-y divide-gray-100">
    {events.map(ev => {
      const { summary, details } = describeEvent(ev);
      return (
        <li key={ev.id} className="py-3">
          <div className="flex justify-between gap-4 text-xs">
            <span className="text-gray-900">
              <strong>{ev.actor_name}</strong> {summary}
              {showInvoice && ev.invoice_number ? <span className="text-gray-500"> · {formatInvoiceNumber(ev.invoice_number)}</span> : null}
            </span>
            <time className="text-gray-400 whitespace-nowrap" dateTime={ev.at}>{new Date(ev.at).toLocaleString()}</time>
          </div>
          {details.length > 0 && (
            <ul className="mt-1 text-[11px] text-gray-500 list-disc pl-5 space-y-0.5">
              {details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
        </li>
      );
    })}
  </ul>
);

const InvoiceHistory = ({ invoice, onClose }) => {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    supabase
      .from('invoice_events')
      .select('*')
      .eq('invoice_id', invoice.id)
      .order('at', { ascending: false })
      .order('id', { ascending: false })
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err) setError(err.message); else setEvents(data);
      });
    return () => { active = false; };
  }, [invoice.id]);

  return (
    <div className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-xl shadow-xl p-6 max-w-lg w-full max-h-[80vh] flex flex-col"
      >
        <h3 className="text-base font-bold text-gray-900 mb-1">
          History {invoice.invoiceNumber ? `· ${formatInvoiceNumber(invoice.invoiceNumber)}` : ''}
        </h3>
        <p className="text-xs text-gray-500 mb-3">{invoice.customerName}</p>
        <div className="overflow-y-auto flex-1">
          {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
          {!events && !error && <p className="text-xs text-gray-500">Loading...</p>}
          {events && events.length === 0 && <p className="text-xs text-gray-500">No history recorded for this invoice yet.</p>}
          {events && events.length > 0 && <EventList events={events} />}
        </div>
        <div className="flex justify-end pt-4">
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50">Close</button>
        </div>
      </motion.div>
    </div>
  );
};

export default InvoiceHistory;
