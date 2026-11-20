import React, { useCallback, useEffect, useState } from 'react';
import { STATE_NAMES, SERVICE_STATES, safeUrl } from './bidUtils';

const input = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent';
const label = 'block text-xs font-semibold text-gray-600 mb-1';
const EMPTY = { name: '', url: '', state: 'OH', county: '' };

const Dot = ({ ok, children }) => (
  <span className={`inline-flex items-center gap-1.5 text-xs ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>
    <span aria-hidden="true" className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />{children}
  </span>
);

const summarize = (r) => {
  const bits = [];
  const sam = r.report?.sam; const pg = r.report?.pages; const em = r.report?.email;
  if (sam) bits.push(sam.skipped ? `SAM.gov skipped (${sam.reason})` : sam.ok === false ? `SAM.gov problem: ${sam.error}` : `SAM.gov: ${sam.matched ?? 0} matching notices (${sam.inserted ?? 0} new)`);
  if (pg) bits.push(pg.ok === false ? `Pages problem: ${pg.error}` : `Pages: ${pg.checked} checked, ${pg.found} bids found (${pg.inserted} new)${pg.problems ? `, ${pg.problems} need attention` : ''}${pg.remaining ? `, ${pg.remaining} left for next run` : ''}`);
  if (em) bits.push(em.ok === false ? `Emails problem: ${em.error}` : `Emails: ${em.processed} read, ${em.found} bids found${em.waiting ? `, ${em.waiting} waiting` : ''}`);
  return bits.join(' · ');
};

const SourcesModal = ({ bids, onClose }) => {
  const [status, setStatus] = useState(null);
  const [pages, setPages] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [sam, setSam] = useState({ enabled: bids.settings.sam_enabled !== 'false', keywords: bids.settings.sam_keywords ?? '' });
  const [mail, setMail] = useState({ address: bids.settings.inbound_address ?? '', senders: bids.settings.email_senders ?? '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const refresh = useCallback(async () => {
    const [st, pg, ib] = await Promise.allSettled([bids.getFinderStatus(), bids.loadPages(), bids.loadInbox()]);
    if (st.status === 'fulfilled') setStatus(st.value); else setStatus({ error: st.reason?.message || 'Could not reach the finder.' });
    if (pg.status === 'fulfilled') setPages(pg.value);
    if (ib.status === 'fulfilled') setInbox(ib.value);
  }, [bids]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (key, fn, ok) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: ok ? ok(r) : 'Done.' }); await refresh(); return r; }
    catch (e) { setMsg({ ok: false, text: e.message || 'That did not work.' }); }
    finally { setBusy(''); }
  };

  const addPage = async (e) => {
    e.preventDefault();
    if (!safeUrl(form.url.trim())) return setMsg({ ok: false, text: 'The link must start with http:// or https://' });
    const r = await run('add', () => bids.addPage({ name: form.name.trim(), url: form.url.trim(), state: form.state, county: form.county.trim() || null }), () => 'Page added. It is read on the next daily run, or click Check now.');
    if (r !== undefined) setForm(EMPTY);
  };
  const saveSettings = () => run('save', () => bids.saveSettings({
    sam_enabled: sam.enabled, sam_keywords: sam.keywords.trim(), inbound_address: mail.address.trim(), email_senders: mail.senders.trim(),
  }), () => 'Saved.');

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Bid sources">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Bid sources</h3>
            <p className="text-xs text-gray-500">Where the board looks for bids by itself every morning.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 text-xl px-2">×</button>
        </div>

        <div className="px-6 py-5 space-y-8">
          {msg && <div role={msg.ok ? 'status' : 'alert'} className={`text-xs p-3 rounded-lg border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{msg.text}</div>}

          {/* Status */}
          <section aria-label="Status" className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
            {!status ? <span className="text-xs text-gray-500">Checking…</span> : status.error ? <span role="alert" className="text-xs text-red-700">{status.error}</span> : (
              <>
                <Dot ok={status.ai}>{status.ai ? `AI reading is on (${status.aiUsedToday} of ${status.aiDailyCap} reads used today)` : 'AI reading is off: add the ANTHROPIC_API_KEY secret'}</Dot>
                <Dot ok={status.sam}>{status.sam ? 'SAM.gov key found' : 'SAM.gov is off: add the SAM_API_KEY secret'}</Dot>
                <span className="text-xs text-gray-600">{status.watchedPages} page{status.watchedPages === 1 ? '' : 's'} watched · {status.queuedEmails} email{status.queuedEmails === 1 ? '' : 's'} waiting to be read</span>
              </>
            )}
            <button onClick={() => run('discover', bids.runDiscovery, summarize)} disabled={!!busy} className="ml-auto px-3 py-1.5 bg-gray-900 text-white rounded-lg text-xs font-semibold disabled:opacity-60">
              {busy === 'discover' ? 'Looking…' : 'Look for bids now'}
            </button>
          </section>

          {/* Pages */}
          <section aria-label="Watched pages">
            <h4 className="text-sm font-bold text-gray-900">Public pages we watch</h4>
            <p className="text-xs text-gray-500 mt-1 mb-3">Township, city, county and fire-district bid pages. Each is read once a day, only when it changed, and the site's robots.txt rules are respected. Pages that need JavaScript, or that are just a PDF, can't be read yet; add the page that links to them instead.</p>
            {pages.length === 0 ? <p className="text-sm text-gray-400 mb-3">No pages yet.</p> : (
              <div className="overflow-x-auto border border-gray-200 rounded-lg mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500"><tr>
                    <th className="text-left px-3 py-2">Page</th><th className="text-left px-3 py-2">Last check</th><th className="px-3 py-2" />
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {pages.map((p) => (
                      <tr key={p.id} data-testid="watch-row" className={p.active ? '' : 'opacity-50'}>
                        <td className="px-3 py-2 align-top">
                          <div className="font-semibold text-gray-900">{p.name} <span className="font-normal text-gray-500">· {[p.county && `${p.county} Co.`, p.state].filter(Boolean).join(', ')}</span></div>
                          <a href={safeUrl(p.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-red-700 hover:underline break-all">{p.url}</a>
                        </td>
                        <td className="px-3 py-2 align-top text-gray-600">
                          {p.last_checked_at ? <>{new Date(p.last_checked_at).toLocaleString()}<div>{p.last_status}</div></> : 'Not checked yet'}
                        </td>
                        <td className="px-3 py-2 align-top whitespace-nowrap space-x-3 text-right">
                          <button onClick={() => run(`c${p.id}`, () => bids.checkPage(p.id), (r) => `Checked: ${r.pages?.found ?? 0} bids found.`)} disabled={!!busy || !p.active} className="font-semibold text-gray-700 hover:underline disabled:opacity-40">Check now</button>
                          <button onClick={() => run(`p${p.id}`, () => bids.updatePage(p.id, { active: !p.active }), () => (p.active ? 'Paused.' : 'Resumed.'))} disabled={!!busy} className="font-semibold text-gray-700 hover:underline">{p.active ? 'Pause' : 'Resume'}</button>
                          <button onClick={() => window.confirm(`Stop watching ${p.name}?`) && run(`d${p.id}`, () => bids.deletePage(p.id), () => 'Removed.')} disabled={!!busy} className="font-semibold text-red-700 hover:underline">Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form onSubmit={addPage} className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
              <div className="md:col-span-1"><label className={label} htmlFor="w-name">Name *</label><input id="w-name" required className={input} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Stark Twp Fire" /></div>
              <div className="md:col-span-2"><label className={label} htmlFor="w-url">Page address *</label><input id="w-url" required type="url" className={input} value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://" /></div>
              <div><label className={label} htmlFor="w-state">State</label>
                <select id="w-state" className={input} value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}>{SERVICE_STATES.map((s) => <option key={s} value={s}>{STATE_NAMES[s]}</option>)}</select></div>
              <div><label className={label} htmlFor="w-county">County</label><input id="w-county" className={input} value={form.county} onChange={(e) => setForm((f) => ({ ...f, county: e.target.value }))} placeholder="Stark" /></div>
              <div className="col-span-2 md:col-span-5 flex justify-end"><button type="submit" disabled={!!busy} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">Add page</button></div>
            </form>
          </section>

          {/* SAM.gov */}
          <section aria-label="SAM.gov">
            <h4 className="text-sm font-bold text-gray-900">SAM.gov (federal bids)</h4>
            <p className="text-xs text-gray-500 mt-1 mb-3">Each morning we look at new federal notices with a place of performance in Ohio, Pennsylvania or West Virginia and keep the ones that mention fire equipment. Few local departments post here, so expect a small number.</p>
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-3"><input type="checkbox" checked={sam.enabled} onChange={(e) => setSam((s) => ({ ...s, enabled: e.target.checked }))} /> Check SAM.gov every day</label>
            <label className={label} htmlFor="sam-kw">Keywords (comma separated)</label>
            <textarea id="sam-kw" rows={2} className={input} value={sam.keywords} onChange={(e) => setSam((s) => ({ ...s, keywords: e.target.value }))} />
          </section>

          {/* Email */}
          <section aria-label="Alert emails">
            <h4 className="text-sm font-bold text-gray-900">Alert emails</h4>
            <p className="text-xs text-gray-500 mt-1 mb-3">Subscribe to bid alerts (BidNet, state portals, newspaper notice sites) using the address below, or forward them to it. Only mail from the senders you list is read; everything else is ignored.</p>
            <div className="grid md:grid-cols-2 gap-3">
              <div><label className={label} htmlFor="m-addr">Alert address (shown to your team)</label><input id="m-addr" className={input} value={mail.address} onChange={(e) => setMail((m) => ({ ...m, address: e.target.value }))} placeholder="bids@yourdomain.com" /></div>
              <div><label className={label} htmlFor="m-senders">Allowed senders (domains or addresses, comma separated)</label><input id="m-senders" className={input} value={mail.senders} onChange={(e) => setMail((m) => ({ ...m, senders: e.target.value }))} placeholder="bidnet.com, you@example.com" /></div>
            </div>
            {!mail.senders.trim() && <p className="text-xs text-amber-700 mt-2">No senders listed, so no alert emails are accepted yet.</p>}
            {inbox.length > 0 && (
              <ul className="mt-3 text-xs text-gray-600 divide-y divide-gray-100 border border-gray-200 rounded-lg" aria-label="Recent alert emails">
                {inbox.map((m) => <li key={m.id} className="px-3 py-2 flex justify-between gap-3"><span className="truncate">{m.subject || '(no subject)'} <span className="text-gray-400">· {m.sender}</span></span><span className="whitespace-nowrap">{m.status}{m.status === 'processed' ? ` · ${m.leads_found} bid${m.leads_found === 1 ? '' : 's'}` : ''}</span></li>)}
              </ul>
            )}
          </section>

          <div className="flex justify-end gap-3 border-t border-gray-100 pt-4">
            <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Close</button>
            <button onClick={saveSettings} disabled={!!busy} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">Save settings</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SourcesModal;
