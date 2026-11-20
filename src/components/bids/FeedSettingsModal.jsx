import React, { useEffect, useState } from 'react';
import supabase from '../../lib/supabase';
import { DEFAULT_FEED_URL } from './bidUtils';

const FeedSettingsModal = ({ settings, isOffice, onSave, onRunDaily, onClose }) => {
  const [feedUrl, setFeedUrl] = useState(settings.feed_url ?? DEFAULT_FEED_URL);
  const [digestOn, setDigestOn] = useState(settings.digest_enabled !== 'false');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);

  useEffect(() => {
    if (!isOffice) return;
    supabase.from('bid_digests').select('sent_at, leads, recipients, triggered_by').order('sent_at', { ascending: false }).limit(1)
      .then(({ data }) => setLast(data?.[0] ?? null));
  }, [isOffice]);

  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: ok(r) }); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const save = () => run(() => onSave({ feed_url: feedUrl.trim(), digest_enabled: digestOn }), () => 'Settings saved.');
  const daily = () => {
    if (!window.confirm('Check the feed now and email the digest to everyone with an account?')) return;
    return run(onRunDaily, (r) => (r.digest?.sent
      ? `Digest sent to ${r.digest.recipients} people (${r.digest.newLeads} new, ${r.digest.dueSoon} due soon).`
      : `Nothing emailed: ${r.digest?.reason || r.digest?.error || 'no new bids'}`));
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Feed settings">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">Feed settings</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 text-xl px-2">×</button>
        </div>
        {msg && <div role={msg.ok ? 'status' : 'alert'} className={`text-xs p-3 rounded-lg border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{msg.text}</div>}

        <div>
          <label htmlFor="feed-url" className="block text-xs font-semibold text-gray-600 mb-1">JSON feed URL</label>
          <input id="feed-url" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} disabled={!isOffice} placeholder={DEFAULT_FEED_URL}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50" />
          <p className="text-xs text-gray-500 mt-1">A public link to a JSON list of leads. The default, <code>{DEFAULT_FEED_URL}</code>, is a file inside this app. Leave empty to turn the feed off. It is checked every day and when someone clicks Refresh Feed.</p>
        </div>

        <label className="flex items-start gap-3 text-sm text-gray-700">
          <input type="checkbox" className="mt-1" checked={digestOn} onChange={(e) => setDigestOn(e.target.checked)} disabled={!isOffice} />
          <span><strong>Email a daily digest</strong> of new bids (and bids due within 7 days) to everyone with an account.
            <span className="block text-xs text-gray-500">Nothing is sent on days with nothing new.</span></span>
        </label>

        {isOffice && last && <p className="text-xs text-gray-500">Last digest: {new Date(last.sent_at).toLocaleString()} · {last.leads} new bids · {last.recipients} recipients ({last.triggered_by}).</p>}
        {!isOffice && <p className="text-xs text-gray-500">Only office staff can change these settings.</p>}

        <div className="flex flex-wrap justify-between gap-3 pt-2">
          {isOffice ? <button onClick={daily} disabled={busy} className="px-3 py-2 border border-gray-300 rounded-lg text-xs font-semibold disabled:opacity-60">Run today's check and email now</button> : <span />}
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Close</button>
            {isOffice && <button onClick={save} disabled={busy} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">Save</button>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FeedSettingsModal;
