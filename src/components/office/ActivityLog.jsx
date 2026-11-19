import React, { useCallback, useEffect, useState } from 'react';
import supabase from '../../lib/supabase';
import { EventList } from '../invoice/InvoiceHistory';

const PAGE = 100;

// Office-wide activity feed, including deleted invoices and backup restores.
const ActivityLog = () => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const load = useCallback(async (offset) => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('invoice_events')
      .select('*')
      .order('at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + PAGE - 1);
    setLoading(false);
    if (err) return setError(err.message);
    setError('');
    setEvents(prev => (offset === 0 ? data : [...prev, ...data]));
    setDone(data.length < PAGE);
  }, []);

  useEffect(() => { load(0); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-gray-900 tracking-tight">Activity</h2>
        <p className="text-xs text-gray-500">Every invoice change, who made it and when. This log can't be edited.</p>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
        {!error && !loading && events.length === 0 && <p className="text-xs text-gray-500">Nothing recorded yet.</p>}
        {events.length > 0 && <EventList events={events} showInvoice />}
        {loading && <p className="text-xs text-gray-500 py-2">Loading...</p>}
        {!loading && !done && !error && (
          <button onClick={() => load(events.length)} className="mt-3 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-semibold hover:bg-gray-50">
            Load more
          </button>
        )}
      </div>
    </div>
  );
};

export default ActivityLog;
