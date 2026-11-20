import { useCallback, useEffect, useMemo, useState } from 'react';
import supabase from '../../lib/supabase';
import { countySet, DEFAULT_FEED_URL } from './bidUtils';
import { buildSampleLeads } from './sampleLeads';

const fetchAllLeads = async () => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('bid_leads').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
};

// Turns a failed function call into a readable message (the function replies with { error })
const invokeBids = async (body) => {
  const { data, error } = await supabase.functions.invoke('bids-daily', { body: { ...body, origin: window.location.origin } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
};

// Same idea for the finder function
const invokeFinder = async (body) => {
  const { data, error } = await supabase.functions.invoke('bids-find', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
};

export function useBids() {
  const [leads, setLeads] = useState([]);
  const [counties, setCounties] = useState([]);
  const [settings, setSettings] = useState({ feed_url: DEFAULT_FEED_URL, digest_enabled: 'true' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedStatus, setFeedStatus] = useState({ state: 'idle', message: '' });

  const load = useCallback(async () => {
    try {
      const [l, c, s] = await Promise.all([
        fetchAllLeads(),
        supabase.from('bid_counties').select('state, county'),
        supabase.from('bid_settings').select('key, value'),
      ]);
      if (c.error) throw c.error;
      if (s.error) throw s.error;
      setLeads(l);
      setCounties(c.data);
      setSettings((prev) => ({ ...prev, ...Object.fromEntries(s.data.map((r) => [r.key, r.value])) }));
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load bids');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const importLeads = useCallback(async (list, { sample = false } = {}) => {
    const { data, error: err } = await supabase.rpc('import_bid_leads', { p_leads: list, p_mark_sample: sample });
    if (err) throw err;
    await load();
    return data;
  }, [load]);

  const loadSamples = useCallback(() => importLeads(buildSampleLeads(), { sample: true }), [importLeads]);

  // Status and notes are shared by everyone on staff. The change shows immediately and rolls back if the save fails.
  const updateLead = useCallback(async (id, patch) => {
    const before = leads;
    setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    const { data, error: err } = await supabase.from('bid_leads').update(patch).eq('id', id).select('id');
    if (err || !data?.length) {
      setLeads(before);
      throw new Error(err?.message || 'You do not have permission to change that bid.');
    }
  }, [leads]);

  const deleteLeads = useCallback(async (match) => {
    let q = supabase.from('bid_leads').delete();
    q = match.id ? q.eq('id', match.id) : q.eq('is_sample', true);
    const { data, error: err } = await q.select('id');
    if (err) throw err;
    await load();
    return data?.length ?? 0;
  }, [load]);

  const saveSettings = useCallback(async (next) => {
    const rows = Object.entries(next).map(([key, value]) => ({ key, value: String(value) }));
    const { data, error: err } = await supabase.from('bid_settings').upsert(rows, { onConflict: 'key' }).select('key');
    if (err || !data?.length) throw new Error(err?.message || 'Only office staff can change these settings.');
    setSettings((prev) => ({ ...prev, ...next }));
  }, []);

  const refreshFeed = useCallback(async () => {
    setFeedStatus({ state: 'busy', message: 'Checking the feed…' });
    try {
      const res = await invokeBids({ action: 'refresh_feed' });
      const f = res.feed ?? {};
      if (f.skipped) setFeedStatus({ state: 'none', message: f.reason || 'No feed is set.' });
      else if (f.ok === false) setFeedStatus({ state: 'error', message: f.error });
      else setFeedStatus({ state: 'ok', message: `${f.found ?? 0} in feed · ${f.inserted ?? 0} new · ${f.merged ?? 0} merged`, at: new Date() });
      await load();
      return res;
    } catch (e) {
      setFeedStatus({ state: 'error', message: e.message });
      throw e;
    }
  }, [load]);

  const runDaily = useCallback(async () => {
    const res = await invokeBids({ action: 'daily' });
    await load();
    return res;
  }, [load]);

  // ── automatic finding ──────────────────────────────────────────────────────
  const extractText = useCallback(async (args) => {
    const res = await invokeFinder({ action: 'extract_text', ...args });
    await load();
    return res;
  }, [load]);
  const getFinderStatus = useCallback(() => invokeFinder({ action: 'status' }), []);
  const runDiscovery = useCallback(async () => {
    const res = await invokeFinder({ action: 'discover' });
    await load();
    return res;
  }, [load]);
  const checkPage = useCallback(async (pageId) => {
    const res = await invokeFinder({ action: 'check_page', pageId });
    await load();
    return res;
  }, [load]);

  const loadPages = useCallback(async () => {
    const { data, error: err } = await supabase.from('bid_watch_pages').select('*').order('name');
    if (err) throw err;
    return data;
  }, []);
  const addPage = useCallback(async (page) => {
    const { error: err } = await supabase.from('bid_watch_pages').insert(page);
    if (err) throw new Error(/duplicate|unique/i.test(err.message) ? 'That page is already being watched.' : err.message);
  }, []);
  const updatePage = useCallback(async (id, patch) => {
    const { data, error: err } = await supabase.from('bid_watch_pages').update(patch).eq('id', id).select('id');
    if (err || !data?.length) throw new Error(err?.message || 'Only office staff can change watched pages.');
  }, []);
  const deletePage = useCallback(async (id) => {
    const { data, error: err } = await supabase.from('bid_watch_pages').delete().eq('id', id).select('id');
    if (err || !data?.length) throw new Error(err?.message || 'Only office staff can remove watched pages.');
  }, []);
  const loadInbox = useCallback(async () => {
    const { data, error: err } = await supabase.from('bid_inbox').select('id, received_at, sender, subject, status, leads_found, note')
      .order('received_at', { ascending: false }).limit(10);
    if (err) throw err;
    return data;
  }, []);

  const counts = useMemo(() => countySet(counties), [counties]);
  const lastUpdated = useMemo(() => leads.reduce((m, l) => Math.max(m, Date.parse(l.updated_at ?? l.last_seen_at ?? 0) || 0), 0), [leads]);

  return { leads, counties, countyKeys: counts, settings, loading, error, feedStatus, lastUpdated,
    reload: load, importLeads, loadSamples, updateLead, deleteLeads, saveSettings, refreshFeed, runDaily,
    extractText, getFinderStatus, runDiscovery, checkPage, loadPages, addPage, updatePage, deletePage, loadInbox };
}
