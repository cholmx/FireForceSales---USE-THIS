import React, { useState } from 'react';
import { SERVICE_STATES, STATE_NAMES, parseLeadsJson, leadFromForm } from './bidUtils';

const EMPTY = { agency_name: '', city: '', county: '', state: 'OH', solicitation_number: '', due_date: '', grant_funded: false, summary: '', items: '', source_name: '', source_url: '' };
const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent';
const label = 'block text-xs font-semibold text-gray-600 mb-1';

const describe = (r) =>
  `${r.inserted} added, ${r.merged} merged into existing bids${r.skipped ? `, ${r.skipped} skipped` : ''}.` +
  (r.errors?.length ? ` ${r.errors.slice(0, 3).map((e) => `#${e.index}: ${e.error}`).join(' · ')}` : '');

const AddBidModal = ({ isOffice, onImport, onExtract, onLoadSamples, onRemoveSamples, onClose }) => {
  const [tab, setTab] = useState('form');
  const [form, setForm] = useState(EMPTY);
  const [json, setJson] = useState('');
  const [notice, setNotice] = useState({ text: '', sourceName: '', sourceUrl: '' });
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const run = async (fn, done) => {
    setBusy(true); setMessage(null);
    try { const r = await fn(); setMessage({ ok: true, text: done(r) }); return r; }
    catch (e) { setMessage({ ok: false, text: e.message || 'That did not work.' }); }
    finally { setBusy(false); }
  };

  const submitForm = async (e) => {
    e.preventDefault();
    const r = await run(() => onImport([leadFromForm(form)]), describe);
    if (r && r.inserted + r.merged > 0) setForm(EMPTY);
  };
  const submitJson = (e) => {
    e.preventDefault();
    let leads;
    try { leads = parseLeadsJson(json); } catch (err) { return setMessage({ ok: false, text: err.message }); }
    return run(() => onImport(leads), describe);
  };
  const submitNotice = async (e) => {
    e.preventDefault();
    setFound(null);
    const r = await run(() => onExtract({ text: notice.text, sourceName: notice.sourceName.trim() || undefined, sourceUrl: notice.sourceUrl.trim() || undefined }),
      (res) => (res.found === 0
        ? `Claude didn't find an open fire-equipment bid in that text${res.ignored ? ` (${res.ignored} item${res.ignored === 1 ? '' : 's'} ignored: awards or unrelated notices)` : ''}.`
        : `Found ${res.found} bid${res.found === 1 ? '' : 's'}: ${res.import?.inserted ?? 0} added, ${res.import?.merged ?? 0} merged into existing bids${res.ignored ? `, ${res.ignored} ignored` : ''}.`));
    if (r?.leads?.length) { setFound(r.leads); setNotice({ text: '', sourceName: '', sourceUrl: '' }); }
  };
  const readFile = async (e) => {
    const file = e.target.files?.[0];
    if (file) setJson(await file.text());
    e.target.value = '';
  };

  const tabBtn = (id, text) => (
    <button type="button" onClick={() => { setTab(id); setMessage(null); }}
      className={`px-3 py-2 text-xs font-semibold border-b-2 ${tab === id ? 'border-red-600 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{text}</button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add or import bids">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5">
          <h3 className="text-lg font-bold text-gray-900">Add or import bids</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 text-xl px-2">×</button>
        </div>
        <div className="px-6 flex border-b border-gray-200 mt-2">{tabBtn('form', 'Enter a bid')}{tabBtn('notice', 'Paste a notice (AI)')}{tabBtn('json', 'Paste or upload JSON')}{tabBtn('sample', 'Sample data')}</div>

        <div className="px-6 py-5">
          {message && (
            <div role={message.ok ? 'status' : 'alert'} className={`mb-4 text-xs p-3 rounded-lg border ${message.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{message.text}</div>
          )}

          {tab === 'form' && (
            <form onSubmit={submitForm} className="grid grid-cols-2 gap-4">
              <div className="col-span-2"><label className={label} htmlFor="b-agency">Agency *</label><input id="b-agency" required className={input} value={form.agency_name} onChange={set('agency_name')} placeholder="e.g. Riverside Township Fire Department" /></div>
              <div><label className={label} htmlFor="b-state">State *</label>
                <select id="b-state" className={input} value={form.state} onChange={set('state')}>{SERVICE_STATES.map((s) => <option key={s} value={s}>{STATE_NAMES[s]}</option>)}<option value="OTHER">Other</option></select></div>
              <div><label className={label} htmlFor="b-county">County</label><input id="b-county" className={input} value={form.county} onChange={set('county')} placeholder="Stark" /></div>
              <div><label className={label} htmlFor="b-city">City</label><input id="b-city" className={input} value={form.city} onChange={set('city')} /></div>
              <div><label className={label} htmlFor="b-sol">Solicitation #</label><input id="b-sol" className={input} value={form.solicitation_number} onChange={set('solicitation_number')} /></div>
              <div><label className={label} htmlFor="b-due">Due date</label><input id="b-due" type="date" className={input} value={form.due_date} onChange={set('due_date')} /></div>
              <label className="flex items-center gap-2 text-sm text-gray-700 self-end pb-2"><input type="checkbox" checked={form.grant_funded} onChange={set('grant_funded')} /> Grant funded (FEMA AFG etc.)</label>
              <div className="col-span-2"><label className={label} htmlFor="b-items">Equipment (one per line, optional quantity like “SCBA packs x10”)</label>
                <textarea id="b-items" rows={3} className={input} value={form.items} onChange={set('items')} /></div>
              <div className="col-span-2"><label className={label} htmlFor="b-summary">Summary or pasted notice text</label><textarea id="b-summary" rows={3} className={input} value={form.summary} onChange={set('summary')} /></div>
              <div><label className={label} htmlFor="b-sname">Where you found it</label><input id="b-sname" className={input} value={form.source_name} onChange={set('source_name')} placeholder="Newspaper, BidNet…" /></div>
              <div><label className={label} htmlFor="b-surl">Link</label><input id="b-surl" type="url" className={input} value={form.source_url} onChange={set('source_url')} placeholder="https://" /></div>
              <div className="col-span-2 flex justify-end gap-3">
                <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Close</button>
                <button type="submit" disabled={busy} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">{busy ? 'Adding…' : 'Add bid'}</button>
              </div>
              <p className="col-span-2 text-xs text-gray-500">If this bid is already on the board (same solicitation number, or same agency with a nearby due date), it is merged into the existing one instead of added twice.</p>
            </form>
          )}

          {tab === 'notice' && (
            <form onSubmit={submitNotice} className="space-y-3">
              <p className="text-xs text-gray-600">Paste a legal notice, an email or part of a web page. Claude reads it and adds any open fire-equipment bid it finds (agency, county, due date, equipment). Awards and unrelated notices are ignored. Check the result on the board afterwards, since AI can misread a notice.</p>
              <textarea value={notice.text} onChange={(e) => setNotice((n) => ({ ...n, text: e.target.value }))} rows={9} aria-label="Notice text" className={input} placeholder="Paste the notice here…" />
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label} htmlFor="n-name">Where it came from</label><input id="n-name" className={input} value={notice.sourceName} onChange={(e) => setNotice((n) => ({ ...n, sourceName: e.target.value }))} placeholder="Morning Journal, BidNet…" /></div>
                <div><label className={label} htmlFor="n-url">Link (optional)</label><input id="n-url" type="url" className={input} value={notice.sourceUrl} onChange={(e) => setNotice((n) => ({ ...n, sourceUrl: e.target.value }))} placeholder="https://" /></div>
              </div>
              {found && (
                <ul className="text-xs text-gray-700 space-y-1 border border-gray-200 rounded-lg p-3 bg-gray-50">
                  {found.map((l, i) => <li key={i}><strong>{l.agency_name}</strong> ({[l.county && `${l.county} Co.`, l.state].filter(Boolean).join(', ')}) · due {l.due_date || 'not stated'} · {(l.items ?? []).map((x) => x.item_name).slice(0, 3).join(', ') || 'no items listed'}</li>)}
                </ul>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Close</button>
                <button type="submit" disabled={busy || notice.text.trim().length < 20} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">{busy ? 'Reading…' : 'Read this notice'}</button>
              </div>
            </form>
          )}

          {tab === 'json' && (
            <form onSubmit={submitJson} className="space-y-3">
              <p className="text-xs text-gray-600">Paste a JSON array of leads (or one lead), or upload a <code>.json</code> file. Fields: agency_name, state, county, city, solicitation_number, due_date (YYYY-MM-DD), grant_funded, summary, items [item_name, quantity, preferred_brands, nfpa_standards], sources [source, url].</p>
              <input type="file" accept="application/json,.json" onChange={readFile} aria-label="Upload JSON file" className="text-xs" />
              <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={10} aria-label="Leads JSON" className={`${input} font-mono text-xs`} placeholder='[{"agency_name": "…", "state": "OH", "county": "Stark", "due_date": "2026-12-15"}]' />
              <div className="flex justify-end gap-3">
                <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Close</button>
                <button type="submit" disabled={busy || !json.trim()} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">{busy ? 'Importing…' : 'Import'}</button>
              </div>
            </form>
          )}

          {tab === 'sample' && (
            <div className="space-y-4 text-sm text-gray-700">
              <p>Eight made-up bids across Ohio, Pennsylvania and West Virginia so you can try the filters and the detail panel. Samples are marked <strong>Sample</strong> and are never included in the daily email.</p>
              <div className="flex gap-3">
                <button disabled={busy} onClick={() => run(onLoadSamples, (r) => `Loaded sample data: ${describe(r)}`)} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-semibold disabled:opacity-60">Load sample data</button>
                {isOffice && <button disabled={busy} onClick={() => run(onRemoveSamples, (n) => `Removed ${n} sample bid${n === 1 ? '' : 's'}.`)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold disabled:opacity-60">Remove sample data</button>}
              </div>
              {!isOffice && <p className="text-xs text-gray-500">Only office staff can remove sample data.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AddBidModal;
