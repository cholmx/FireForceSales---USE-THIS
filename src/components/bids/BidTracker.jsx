import React, { useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useBids } from './useBids';
import BidDrawer, { STATUS_STYLES, TONE_STYLES } from './BidDrawer';
import AddBidModal from './AddBidModal';
import FeedSettingsModal from './FeedSettingsModal';
import {
  STATUSES, CATEGORIES, SERVICE_STATES, STATE_NAMES, DEFAULT_FILTERS, todayISO, areaOf, dueInfo, computeMetrics,
  filterLeads, sortLeads, itemSummary, nfpaOf, brandsOf, safeUrl,
} from './bidUtils';

const Metric = ({ label, value, hint }) => (
  <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</div>
    <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
    {hint && <div className="text-[11px] text-gray-400">{hint}</div>}
  </div>
);

const FEED_BADGE = {
  idle: ['bg-gray-100 text-gray-600 border-gray-200', 'Feed not checked yet'],
  busy: ['bg-blue-50 text-blue-700 border-blue-200', 'Checking…'],
  ok: ['bg-emerald-50 text-emerald-700 border-emerald-200', 'Feed OK'],
  error: ['bg-red-50 text-red-700 border-red-200', 'Feed error'],
  none: ['bg-gray-100 text-gray-600 border-gray-200', 'No feed set'],
};

const select = 'px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-red-500 focus:border-transparent';

const BidTracker = () => {
  const { user } = useAuth();
  const isOffice = !!user?.isOffice;
  const bids = useBids();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState(null);
  const today = todayISO();
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value, ...(k === 'state' ? { county: 'all' } : {}) }));

  const metrics = useMemo(() => computeMetrics(bids.leads, today, bids.countyKeys), [bids.leads, bids.countyKeys, today]);
  const visible = useMemo(
    () => sortLeads(filterLeads(bids.leads, filters, bids.countyKeys, today), filters.sort, today),
    [bids.leads, filters, bids.countyKeys, today],
  );
  const countyOptions = useMemo(
    () => bids.counties.filter((c) => c.state === filters.state).map((c) => c.county).sort(),
    [bids.counties, filters.state],
  );
  const selected = bids.leads.find((l) => l.id === selectedId) ?? null;

  const flash = (ok, text) => { setNotice({ ok, text }); setTimeout(() => setNotice(null), ok ? 5000 : 10000); };
  const onRefresh = async () => {
    try {
      const res = await bids.refreshFeed();
      const f = res.feed ?? {};
      if (f.skipped) flash(true, f.reason || 'No feed is set. Open Feed settings to add one.');
      else if (f.ok === false) flash(false, `Feed problem: ${f.error}`);
      else flash(true, `Feed checked: ${f.inserted ?? 0} new, ${f.merged ?? 0} merged.`);
    } catch (e) { flash(false, `Could not check the feed: ${e.message}`); }
  };
  const changeStatus = async (lead, status) => {
    try { await bids.updateLead(lead.id, { status }); } catch (e) { flash(false, e.message); }
  };

  const [badgeClass, badgeText] = FEED_BADGE[bids.feedStatus.state] ?? FEED_BADGE.idle;
  const empty = !bids.loading && !bids.error && bids.leads.length === 0;

  return (
    <div className="space-y-5">
      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 tracking-tight">FireBid Tracker</h2>
          <p className="text-xs text-gray-500 mt-1">
            Fire-equipment bids in the 42 counties we serve
            {bids.lastUpdated > 0 && <> · Last updated {new Date(bids.lastUpdated).toLocaleString()}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span title={bids.feedStatus.message} className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${badgeClass}`}>
            {badgeText}{bids.feedStatus.state === 'ok' || bids.feedStatus.state === 'error' ? ` · ${bids.feedStatus.message}` : ''}
          </span>
          <button onClick={onRefresh} disabled={bids.feedStatus.state === 'busy'} className="px-3 py-2 border border-gray-300 bg-white rounded-lg text-xs font-semibold hover:bg-gray-50 disabled:opacity-60">Refresh Feed</button>
          <button onClick={() => setShowAdd(true)} className="px-3 py-2 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700">Add / Import</button>
          <button onClick={() => setShowSettings(true)} className="px-3 py-2 border border-gray-300 bg-white rounded-lg text-xs font-semibold hover:bg-gray-50">Feed Settings</button>
        </div>
      </div>

      {notice && <div role={notice.ok ? 'status' : 'alert'} className={`text-xs p-3 rounded-lg border ${notice.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{notice.text}</div>}
      {bids.error && (
        <div role="alert" className="text-sm p-4 rounded-lg border bg-red-50 border-red-200 text-red-700 flex items-center justify-between">
          <span>Couldn't load bids: {bids.error}</span>
          <button onClick={bids.reload} className="font-semibold underline">Try again</button>
        </div>
      )}

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="Active leads" value={metrics.active} hint="open, in our counties" />
        <Metric label="Due within 14 days" value={metrics.due14} />
        <Metric label="Grant-funded" value={metrics.grant} hint="FEMA AFG and other grants" />
        <Metric label="Reviewing or quoted" value={metrics.inProgress} />
      </div>

      {empty ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-xl p-10 text-center space-y-3">
          <h3 className="text-lg font-bold text-gray-900">No bids yet</h3>
          <p className="text-sm text-gray-600 max-w-xl mx-auto">Bids appear here from the daily feed check, or when someone adds them. Try it out with sample data, add a real bid, or refresh the feed.</p>
          <div className="flex justify-center gap-3">
            <button onClick={async () => { try { await bids.loadSamples(); flash(true, 'Sample data loaded.'); } catch (e) { flash(false, e.message); } }} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-semibold">Load sample data</button>
            <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold">Add a bid</button>
            <button onClick={onRefresh} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Refresh Feed</button>
          </div>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-3">
            <div className="flex flex-wrap gap-3">
              <input type="search" value={filters.search} onChange={setF('search')} aria-label="Search bids"
                placeholder="Search agency, city, solicitation #, brand, NFPA code, equipment…" className={`${select} flex-1 min-w-[16rem]`} />
              <select aria-label="Sort" value={filters.sort} onChange={setF('sort')} className={select}>
                <option value="due">Sort: due date (soonest)</option>
                <option value="name">Sort: agency name</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-3 items-center">
              <select aria-label="State" value={filters.state} onChange={setF('state')} className={select}>
                <option value="all">All states</option>
                {SERVICE_STATES.map((s) => <option key={s} value={s}>{STATE_NAMES[s]}</option>)}
              </select>
              <select aria-label="County" value={filters.county} onChange={setF('county')} disabled={filters.state === 'all'} className={`${select} disabled:bg-gray-50`}>
                <option value="all">{filters.state === 'all' ? 'Pick a state for counties' : 'All counties'}</option>
                {countyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                {filters.state !== 'all' && <option value="__unknown">County not confirmed</option>}
              </select>
              <select aria-label="Equipment category" value={filters.category} onChange={setF('category')} className={select}>
                <option value="all">All equipment</option>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <select aria-label="Status filter" value={filters.status} onChange={setF('status')} className={select}>
                <option value="all">All statuses</option>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <select aria-label="Service area" value={filters.area} onChange={setF('area')} className={select}>
                <option value="served">Our counties + county unknown</option>
                <option value="in">Our counties only</option>
                <option value="outside">Outside our area</option>
                <option value="all">Everywhere</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={filters.grantOnly} onChange={setF('grantOnly')} /> Grant-funded only</label>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={filters.showClosed} onChange={setF('showClosed')} /> Show closed</label>
              <button onClick={() => setFilters(DEFAULT_FILTERS)} className="text-xs font-semibold text-gray-500 hover:text-gray-900 ml-auto">Reset filters</button>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-200 text-xs text-gray-500">{visible.length} of {bids.leads.length} bids</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-2.5">Agency &amp; location</th>
                    <th className="text-left px-4 py-2.5">Equipment</th>
                    <th className="text-left px-4 py-2.5">NFPA &amp; brands</th>
                    <th className="text-left px-4 py-2.5">Due</th>
                    <th className="text-left px-4 py-2.5">Status</th>
                    <th className="text-left px-4 py-2.5">Sources</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visible.map((l) => {
                    const area = areaOf(l, bids.countyKeys);
                    const due = dueInfo(l, today);
                    const { shown, more } = itemSummary(l, 2);
                    const tags = [...nfpaOf(l).map((t) => ({ t, k: 'nfpa' })), ...brandsOf(l).map((t) => ({ t, k: 'brand' }))];
                    const links = (l.sources ?? []).map((s) => ({ ...s, href: safeUrl(s.url) })).filter((s) => s.href);
                    return (
                      <tr key={l.id} data-testid="bid-row" tabIndex={0} onClick={() => setSelectedId(l.id)}
                        onKeyDown={(e) => e.key === 'Enter' && setSelectedId(l.id)} className="hover:bg-gray-50 cursor-pointer align-top">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-900">{l.agency_name}</div>
                          <div className="text-xs text-gray-500">{[l.city, l.county ? `${l.county} Co.` : null, l.state].filter(Boolean).join(', ')}</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {l.is_sample && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-gray-300 text-gray-600">Sample</span>}
                            {l.grant_funded && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-700">Grant</span>}
                            {area === 'unknown' && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800">County?</span>}
                            {area === 'outside' && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border border-gray-300 bg-gray-50 text-gray-600">Outside</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-800">
                          {shown.map((s) => <div key={s}>{s}</div>)}
                          {more > 0 && <div className="text-xs text-gray-400">+{more} more</div>}
                          {shown.length === 0 && <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1 max-w-[14rem]">
                            {tags.slice(0, 5).map(({ t, k }) => <span key={`${k}-${t}`} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${k === 'nfpa' ? 'bg-gray-900 text-white' : 'border border-gray-300 text-gray-700'}`}>{t}</span>)}
                            {tags.length > 5 && <span className="text-[10px] text-gray-400">+{tags.length - 5}</span>}
                            {tags.length === 0 && <span className="text-gray-400">—</span>}
                          </div>
                        </td>
                        <td className={`px-4 py-3 whitespace-nowrap ${TONE_STYLES[due.tone]}`}>{due.label}</td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <select aria-label={`Status for ${l.agency_name}`} value={l.status} onChange={(e) => changeStatus(l, e.target.value)}
                            className={`text-xs font-semibold rounded border px-2 py-1 ${STATUS_STYLES[l.status]}`}>
                            {STATUSES.map((s) => <option key={s}>{s}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-xs" onClick={(e) => e.stopPropagation()}>
                          {links.slice(0, 2).map((s) => <div key={s.href}><a href={s.href} target="_blank" rel="noopener noreferrer" className="text-red-700 hover:underline">{s.source || 'Source'}</a></div>)}
                          {links.length > 2 && <div className="text-gray-400">+{links.length - 2} more</div>}
                          {links.length === 0 && <span className="text-gray-400">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visible.length === 0 && !bids.loading && <div className="text-center text-sm text-gray-500 py-12">No bids match these filters.</div>}
            {bids.loading && <div className="text-center text-sm text-gray-500 py-12">Loading…</div>}
          </div>
        </>
      )}

      {selected && (
        <BidDrawer lead={selected} area={areaOf(selected, bids.countyKeys)} today={today} isOffice={isOffice}
          onClose={() => setSelectedId(null)}
          onStatus={(s) => changeStatus(selected, s)}
          onSaveNotes={(notes) => bids.updateLead(selected.id, { notes })}
          onDelete={async () => {
            if (!window.confirm(`Delete the bid from ${selected.agency_name}? This cannot be undone.`)) return;
            try { await bids.deleteLeads({ id: selected.id }); setSelectedId(null); } catch (e) { flash(false, e.message); }
          }} />
      )}
      {showAdd && <AddBidModal isOffice={isOffice} onImport={(list) => bids.importLeads(list)} onLoadSamples={bids.loadSamples}
        onRemoveSamples={() => bids.deleteLeads({ samples: true })} onClose={() => setShowAdd(false)} />}
      {showSettings && <FeedSettingsModal settings={bids.settings} isOffice={isOffice} onSave={bids.saveSettings} onRunDaily={bids.runDaily} onClose={() => setShowSettings(false)} />}
    </div>
  );
};

export default BidTracker;
