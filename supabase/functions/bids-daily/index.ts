// FireBid Tracker: daily check, feed import and digest email.
//
// Actions (POST JSON { action, ... }):
//   daily         import the configured feed, then email the digest      cron secret OR office-level user
//   digest        email the digest only                                   cron secret OR office-level user
//   refresh_feed  import the configured feed (no email)                   any signed-in staff
//   ingest        { leads: [...] } import leads pushed by another tool    cron secret only
//
// "cron secret" = header x-cron-secret equal to the BIDS_CRON_SECRET function secret (used by the scheduled
// GitHub workflow). Leads are cleaned, de-duplicated and merged by the import_bid_leads() database function.
//
// Secrets: BIDS_CRON_SECRET, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO (optional), APP_URL (optional fallback for links
// and for resolving a relative feed URL such as /data/fire_equipment_leads.json).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LEGACY_DOMAIN = '@fireforce.local';
const MAX_FEED_BYTES = 2_000_000;
const IMPORT_CHUNK = 500;
const MAX_DIGEST_LEADS = 40;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const httpOnly = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const cleanOrigin = (v: unknown) => {
  const s = typeof v === 'string' ? v : '';
  if (!/^https?:\/\//i.test(s)) return undefined;
  try { return new URL(s).origin; } catch { return undefined; }
};

// ── feed fetching, with a guard so a feed setting can't be pointed at internal addresses ──────────
export function isSafeFeedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.includes(':')) { // IPv6 literals: loopback, unique-local, link-local, mapped
    return !(h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff'));
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

async function fetchFeed(feedUrl: string, origin: string | undefined): Promise<{ leads: unknown[] } | { error: string }> {
  let target: string;
  try {
    target = new URL(feedUrl, feedUrl.startsWith('/') ? origin : undefined).href;
  } catch {
    return { error: feedUrl.startsWith('/') ? 'The feed URL is relative but the app address is unknown.' : 'The feed URL is not valid.' };
  }
  for (let hop = 0; hop < 4; hop++) {
    if (!isSafeFeedUrl(target)) return { error: 'That feed address is not allowed (it must be a public http or https URL).' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetch(target, { redirect: 'manual', signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = new URL(res.headers.get('location')!, target).href; // re-checked at the top of the loop
        continue;
      }
      if (!res.ok) return { error: `The feed answered with HTTP ${res.status}.` };
      const text = await res.text();
      if (text.length > MAX_FEED_BYTES) return { error: 'The feed is larger than 2 MB.' };
      let data: unknown;
      try { data = JSON.parse(text); } catch { return { error: 'The feed is not valid JSON.' }; }
      const leads = Array.isArray(data) ? data : Array.isArray((data as { leads?: unknown })?.leads) ? (data as { leads: unknown[] }).leads : null;
      if (!leads) return { error: 'The feed must be a JSON array of leads (or an object with a "leads" array).' };
      return { leads };
    } catch (e) {
      return { error: `Could not read the feed: ${(e as Error).name === 'AbortError' ? 'timed out' : e}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: 'The feed redirected too many times.' };
}

// ── email (Resend) ────────────────────────────────────────────────────────────────────────────
type Mail = { to: string; subject: string; html: string; text: string };
async function sendBatch(mails: Mail[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'Email is not set up yet (the RESEND_API_KEY secret is missing).' };
  const from = Deno.env.get('EMAIL_FROM') || 'Fire Force <onboarding@resend.dev>';
  const replyTo = Deno.env.get('EMAIL_REPLY_TO');
  for (let i = 0; i < mails.length; i += 100) {
    const chunk = mails.slice(i, i + 100).map((m) => ({
      from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(replyTo ? { reply_to: replyTo } : {}),
    }));
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk),
      });
      if (!res.ok) return { ok: false, error: `Resend refused the emails (${res.status}). ${(await res.text().catch(() => '')).slice(0, 200)}`.trim() };
    } catch (e) {
      return { ok: false, error: `Could not reach Resend: ${e}` };
    }
  }
  return { ok: true };
}

// ── digest ────────────────────────────────────────────────────────────────────────────────────
type Lead = {
  id: string; agency_name: string; city: string | null; county: string | null; state: string; solicitation_number: string | null;
  due_date: string | null; grant_funded: boolean; status: string; summary: string; items: any[]; sources: any[];
  categories: string[]; first_seen_at: string;
};

const SERVICE_STATES = ['OH', 'PA', 'WV'];
const areaOf = (l: Lead, counties: Set<string>) =>
  !SERVICE_STATES.includes(l.state) ? 'outside' : !l.county ? 'unknown' : counties.has(`${l.state}|${l.county.toLowerCase()}`) ? 'in' : 'outside';

const daysUntil = (due: string | null, today: string) => (due ? Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000) : null);
const fmtDue = (due: string | null, today: string) => {
  if (!due) return 'No due date listed';
  const d = daysUntil(due, today)!;
  const when = new Date(`${due}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return d < 0 ? `${when} (closed)` : d === 0 ? `${when} (today)` : d === 1 ? `${when} (tomorrow)` : `${when} (${d} days)`;
};

function leadBlock(l: Lead, area: string, today: string) {
  const where = [l.city, l.county ? `${l.county} County` : null, l.state].filter(Boolean).join(', ');
  const items = (l.items ?? []).slice(0, 5).map((i) => `${i.item_name ?? ''}${i.quantity ? ` ×${i.quantity}` : ''}`).filter(Boolean).join('; ');
  const links = (l.sources ?? []).map((s) => ({ label: s.source || 'Source', url: httpOnly(s.url) })).filter((s) => s.url);
  const urgent = (() => { const d = daysUntil(l.due_date, today); return d !== null && d >= 0 && d <= 7; })();
  const html = `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
<div style="font-size:14px;font-weight:700">${esc(l.agency_name)}${l.grant_funded ? ' <span style="font-size:10px;background:#E8F5EC;color:#15803D;padding:2px 6px;border-radius:99px;vertical-align:middle">GRANT</span>' : ''}</div>
<div style="font-size:12px;color:#6b7280">${esc(where)}${area === 'unknown' ? ' · county not confirmed' : ''}${l.solicitation_number ? ` · #${esc(l.solicitation_number)}` : ''}</div>
<div style="font-size:12px;margin-top:4px;${urgent ? 'color:#B91C1C;font-weight:700' : ''}">Due: ${esc(fmtDue(l.due_date, today))}</div>
${items ? `<div style="font-size:12px;margin-top:4px">${esc(items)}</div>` : l.summary ? `<div style="font-size:12px;margin-top:4px">${esc(l.summary.slice(0, 200))}</div>` : ''}
${links.length ? `<div style="font-size:12px;margin-top:6px">${links.map((s) => `<a href="${esc(s.url)}" style="color:#C81E1E">${esc(s.label)}</a>`).join(' · ')}</div>` : ''}
</td></tr>`;
  const text = `- ${l.agency_name} (${where})${l.solicitation_number ? ` #${l.solicitation_number}` : ''}\n  Due: ${fmtDue(l.due_date, today)}${items ? `\n  ${items}` : ''}${links.length ? `\n  ${links.map((s) => s.url).join('\n  ')}` : ''}`;
  return { html, text };
}

function buildDigest(fresh: Lead[], soon: Lead[], counties: Set<string>, today: string, appLink: string, extraFresh: number) {
  const section = (title: string, leads: Lead[]) => {
    if (!leads.length) return { html: '', text: '' };
    const byState = new Map<string, Lead[]>();
    for (const l of leads) byState.set(l.state, [...(byState.get(l.state) ?? []), l]);
    let html = `<h2 style="font-size:15px;margin:22px 0 4px;color:#C81E1E">${esc(title)}</h2>`;
    let text = `\n${title.toUpperCase()}\n`;
    for (const [state, list] of byState) {
      html += `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#6b7280;margin-top:10px">${esc(state)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">`;
      text += `\n[${state}]\n`;
      for (const l of list) { const b = leadBlock(l, areaOf(l, counties), today); html += b.html; text += `${b.text}\n`; }
      html += '</table>';
    }
    return { html, text };
  };
  const a = section(`New bids (${fresh.length + extraFresh})`, fresh);
  const b = section(`Due within 7 days (${soon.length})`, soon);
  const more = extraFresh > 0 ? `<p style="font-size:12px;color:#6b7280">…and ${extraFresh} more new bids in the app.</p>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px;border-top:4px solid #C81E1E"><tr><td style="padding:26px 30px">
<div style="font-size:20px;font-weight:800">FIRE FORCE · Bid digest</div>
<div style="font-size:12px;color:#6b7280">${esc(new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))}</div>
${a.html}${more}${b.html}
<p style="margin:24px 0 0"><a href="${esc(appLink)}" style="display:inline-block;background:#C81E1E;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px">Open the Bids board</a></p>
<p style="font-size:11px;color:#9ca3af;margin:14px 0 0">Counties served: 26 in Ohio, 11 in Pennsylvania, 5 in West Virginia. Bids whose county isn't listed are marked "county not confirmed".</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `FIRE FORCE BID DIGEST\n${a.text}${extraFresh > 0 ? `\n...and ${extraFresh} more new bids in the app.\n` : ''}${b.text}\nOpen the Bids board: ${appLink}`;
  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? 'daily';
    const origin = cleanOrigin(body.origin) ?? cleanOrigin(Deno.env.get('APP_URL'));

    // ── who is calling? ─────────────────────────────────────────────────────────
    const secret = Deno.env.get('BIDS_CRON_SECRET');
    const given = req.headers.get('x-cron-secret') ?? '';
    const isCron = !!secret && given.length === secret.length && [...given].every((c, i) => c === secret[i]);
    let role: string | null = null;
    if (!isCron) {
      const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
      const { data: caller } = await admin.auth.getUser(token);
      if (!caller?.user) return json({ error: 'Not authenticated' }, 401);
      const { data: me } = await admin.from('users_ff2024').select('role').eq('auth_id', caller.user.id).maybeSingle();
      role = me?.role ?? null;
      if (!role) return json({ error: 'Not authorized' }, 403);
    }
    const officeLevel = isCron || role === 'owner' || role === 'office';
    const needsOffice = action === 'daily' || action === 'digest';
    if (action === 'ingest' && !isCron) return json({ error: 'Only the scheduled job can push leads' }, 403);
    if (needsOffice && !officeLevel) return json({ error: 'Only office staff can run the daily check' }, 403);
    if (!['daily', 'digest', 'refresh_feed', 'ingest'].includes(action)) return json({ error: 'Unknown action' }, 400);

    const importLeads = async (leads: unknown[]) => {
      const total = { inserted: 0, merged: 0, skipped: 0, errors: [] as unknown[] };
      for (let i = 0; i < leads.length; i += IMPORT_CHUNK) {
        const { data, error } = await admin.rpc('import_bid_leads', { p_leads: leads.slice(i, i + IMPORT_CHUNK), p_mark_sample: false });
        if (error) return { error: error.message };
        total.inserted += data.inserted; total.merged += data.merged; total.skipped += data.skipped; total.errors.push(...(data.errors ?? []));
      }
      return total;
    };

    const readSettings = async () => {
      const { data } = await admin.from('bid_settings').select('key, value');
      const map: Record<string, string> = {};
      for (const r of data ?? []) map[r.key] = r.value;
      return map;
    };

    // ── ingest: another tool pushes leads ───────────────────────────────────────
    if (action === 'ingest') {
      if (!Array.isArray(body.leads)) return json({ error: 'Send { "leads": [ ... ] }' }, 400);
      const result = await importLeads(body.leads);
      return 'error' in result ? json({ error: result.error }, 500) : json({ ok: true, import: result });
    }

    // ── feed import (daily + refresh_feed) ──────────────────────────────────────
    let feed: Record<string, unknown> = { skipped: true };
    if (action === 'daily' || action === 'refresh_feed') {
      const settings = await readSettings();
      const feedUrl = (settings.feed_url ?? '').trim();
      if (!feedUrl) {
        feed = { skipped: true, reason: 'No feed URL is set.' };
      } else {
        const fetched = await fetchFeed(feedUrl, origin);
        if ('error' in fetched) {
          feed = { ok: false, error: fetched.error };
        } else {
          const result = await importLeads(fetched.leads);
          feed = 'error' in result ? { ok: false, error: result.error } : { ok: true, found: fetched.leads.length, ...result };
        }
      }
      if (action === 'refresh_feed') return json({ ok: feed.ok !== false, feed });
    }

    // ── digest ──────────────────────────────────────────────────────────────────
    const settings = await readSettings();
    if (settings.digest_enabled === 'false') return json({ ok: true, feed, digest: { sent: false, reason: 'Daily digest emails are switched off.' } });

    const [{ data: digests }, { data: leadRows }, { data: countyRows }, { data: userRows }] = await Promise.all([
      admin.from('bid_digests').select('sent_at'),
      admin.from('bid_leads').select('*').eq('is_sample', false),
      admin.from('bid_counties').select('state, county'),
      admin.from('users_ff2024').select('email, role, auth_id'),
    ]);
    const lastSent = Math.max(0, ...(digests ?? []).map((d: { sent_at: string }) => Date.parse(d.sent_at)));
    const counties = new Set((countyRows ?? []).map((c: { state: string; county: string }) => `${c.state}|${c.county.toLowerCase()}`));
    const today = new Date().toISOString().slice(0, 10);

    const inArea = (leadRows as Lead[] ?? []).filter((l) => areaOf(l, counties) !== 'outside' && l.status !== 'Passed');
    const byDue = (a: Lead, b: Lead) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999');
    const freshAll = inArea.filter((l) => Date.parse(l.first_seen_at) > lastSent).sort(byDue);
    const freshIds = new Set(freshAll.map((l) => l.id));
    const soon = inArea
      .filter((l) => !freshIds.has(l.id) && (l.status === 'New' || l.status === 'Reviewing') && (daysUntil(l.due_date, today) ?? -1) >= 0 && (daysUntil(l.due_date, today) ?? 99) <= 7)
      .sort(byDue);
    const fresh = freshAll.slice(0, MAX_DIGEST_LEADS);
    if (!freshAll.length && !soon.length) return json({ ok: true, feed, digest: { sent: false, reason: 'Nothing new and nothing due soon.' } });

    const recipients = [...new Set((userRows ?? [])
      .filter((u: { email: string | null; auth_id: string | null }) => u.auth_id && u.email && EMAIL_RE.test(u.email) && !u.email.toLowerCase().endsWith(LEGACY_DOMAIN))
      .map((u: { email: string }) => u.email.toLowerCase()))] as string[];
    if (!recipients.length) return json({ ok: false, feed, digest: { sent: false, error: 'No one has a real email address to send to.' } }, 200);

    const appLink = origin ? `${origin}/bids` : '';
    const built = buildDigest(fresh, soon, counties, today, appLink || '#', freshAll.length - fresh.length);
    const subject = `Fire Force bids: ${freshAll.length} new${soon.length ? `, ${soon.length} due soon` : ''} (${today})`;
    const sent = await sendBatch(recipients.map((to) => ({ to, subject, html: built.html, text: built.text })));
    if (!sent.ok) return json({ ok: false, feed, digest: { sent: false, error: sent.error } }, 200);

    await admin.from('bid_digests').insert({ leads: freshAll.length, recipients: recipients.length, triggered_by: isCron ? 'schedule' : 'manual' });
    return json({ ok: true, feed, digest: { sent: true, newLeads: freshAll.length, dueSoon: soon.length, recipients: recipients.length } });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
