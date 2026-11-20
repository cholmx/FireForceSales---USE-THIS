import React, { useEffect, useState } from 'react';
import { STATUSES, STATE_NAMES, dueInfo, safeUrl, nfpaOf, brandsOf } from './bidUtils';

export const STATUS_STYLES = {
  New: 'bg-blue-50 text-blue-700 border-blue-200',
  Reviewing: 'bg-amber-50 text-amber-800 border-amber-200',
  Quoted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Passed: 'bg-gray-100 text-gray-500 border-gray-200',
};
export const TONE_STYLES = {
  urgent: 'text-red-700 font-bold', soon: 'text-amber-700 font-semibold', normal: 'text-gray-800', closed: 'text-gray-400 line-through', none: 'text-gray-400',
};

const Row = ({ label, children }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</div>
    <div className="text-sm text-gray-900">{children}</div>
  </div>
);

const BidDrawer = ({ lead, area, today, isOffice, onClose, onStatus, onSaveNotes, onDelete }) => {
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState('');

  useEffect(() => { setNotes(lead.notes ?? ''); setSaveState('idle'); }, [lead.id]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const due = dueInfo(lead, today);
  const sources = (lead.sources ?? []).map((s) => ({ ...s, href: safeUrl(s.url) })).filter((s) => s.href);
  const where = [lead.city, lead.county ? `${lead.county} County` : null, STATE_NAMES[lead.state] ?? lead.state].filter(Boolean).join(', ');

  const saveNotes = async () => {
    setSaveState('saving'); setError('');
    try { await onSaveNotes(notes); setSaveState('saved'); } catch (e) { setSaveState('error'); setError(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Bid details for ${lead.agency_name}`}>
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} />
      <aside className="relative bg-white w-full max-w-xl h-full overflow-y-auto shadow-2xl border-l border-gray-200">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between gap-4 z-10">
          <div>
            <h3 className="text-lg font-bold text-gray-900 leading-tight">{lead.agency_name}</h3>
            <p className="text-xs text-gray-500 mt-1">{where}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {lead.is_sample && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-gray-300 text-gray-600">Sample</span>}
              {lead.grant_funded && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-700">Grant funded</span>}
              {area === 'unknown' && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800">County not confirmed</span>}
              {area === 'outside' && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border border-gray-300 bg-gray-50 text-gray-600">Outside service area</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close details" className="text-gray-500 hover:text-gray-900 text-xl leading-none px-2">×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          <div className="grid grid-cols-2 gap-5">
            <Row label="Due"><span className={TONE_STYLES[due.tone]}>{due.label}</span></Row>
            <Row label="Solicitation #">{lead.solicitation_number || <span className="text-gray-400">Not listed</span>}</Row>
            <Row label="Status">
              <select aria-label="Status" value={lead.status} onChange={(e) => onStatus(e.target.value)}
                className={`text-xs font-semibold rounded border px-2 py-1 ${STATUS_STYLES[lead.status]}`}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Row>
            <Row label="First seen">{new Date(lead.first_seen_at).toLocaleDateString()}</Row>
          </div>

          {lead.summary && <Row label="Summary"><p className="whitespace-pre-line leading-relaxed">{lead.summary}</p></Row>}

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Equipment</div>
            {(lead.items ?? []).length === 0 ? <p className="text-sm text-gray-400">No items listed.</p> : (
              <table className="w-full text-sm border border-gray-200 rounded">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <tr><th className="text-left px-3 py-2">Item</th><th className="text-right px-3 py-2">Qty</th><th className="text-left px-3 py-2">Brands</th><th className="text-left px-3 py-2">NFPA</th></tr>
                </thead>
                <tbody>
                  {lead.items.map((it, i) => (
                    <tr key={i} className="border-t border-gray-100 align-top">
                      <td className="px-3 py-2 font-medium">{it.item_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{it.quantity ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{(it.preferred_brands ?? []).join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{(it.nfpa_standards ?? []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(nfpaOf(lead).length > 0 || brandsOf(lead).length > 0) && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {nfpaOf(lead).map((n) => <span key={n} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-gray-900 text-white">{n}</span>)}
                {brandsOf(lead).map((b) => <span key={b} className="text-[10px] font-semibold px-2 py-0.5 rounded border border-gray-300 text-gray-700">{b}</span>)}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Where it was posted ({sources.length})</div>
            {sources.length === 0 ? <p className="text-sm text-gray-400">No links.</p> : (
              <ul className="space-y-1.5">
                {sources.map((s) => (
                  <li key={s.href} className="text-sm">
                    <a href={s.href} target="_blank" rel="noopener noreferrer" className="text-red-700 hover:underline font-medium">{s.source || 'Source'}</a>
                    <span className="block text-xs text-gray-400 truncate">{s.href}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <label htmlFor="bid-notes" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2 block">Team notes (shared with everyone)</label>
            <textarea id="bid-notes" value={notes} onChange={(e) => { setNotes(e.target.value); setSaveState('idle'); }} rows={4}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent" placeholder="Who called, what was quoted, next step…" />
            <div className="flex items-center gap-3 mt-2">
              <button onClick={saveNotes} disabled={saveState === 'saving' || notes === (lead.notes ?? '')}
                className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-xs font-semibold disabled:opacity-40">
                {saveState === 'saving' ? 'Saving…' : 'Save notes'}
              </button>
              {saveState === 'saved' && <span role="status" className="text-xs text-emerald-700">Saved</span>}
              {saveState === 'error' && <span role="alert" className="text-xs text-red-700">{error}</span>}
            </div>
          </div>

          {isOffice && (
            <div className="pt-4 border-t border-gray-100">
              <button onClick={onDelete} className="text-xs font-semibold text-red-700 hover:underline">Delete this bid</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

export default BidDrawer;
