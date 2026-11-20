// FireBid Tracker: receives bid-alert emails and queues them for the daily AI read (bids-find).
//
// This endpoint is PUBLIC (an email provider calls it, so it cannot carry a Supabase login), which is why it does as
// little as possible: it checks who is calling, checks the sender is on the allow-list, stores the email, and stops.
// No AI, no fetching, no importing happens here.
//
// Who may call it (one of):
//   Resend inbound webhooks   signed with Svix; secret in RESEND_WEBHOOK_SECRET ("whsec_...")
//   Anything else (Postmark, Mailgun routes, a forwarding script, Zapier)   header x-inbound-secret or ?token=,
//                              matching INBOUND_EMAIL_SECRET
// Accepted payloads: Resend email.received, Postmark inbound JSON, or { from, subject, text|html, message_id }.
//
// Allowed senders live in the Sources screen (bid_settings.email_senders): domains like bidnet.com or full addresses.
// An empty list accepts nothing.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-inbound-secret, svix-id, svix-timestamp, svix-signature' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_BODY_CHARS = 100_000;
const MAX_PER_DAY = 300;
const SVIX_TOLERANCE_S = 300;

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

// Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the base64 key after "whsec_"; header holds "v1,<sig>" entries
export async function verifySvix(secret: string, id: string, timestamp: string, signatureHeader: string, rawBody: string, nowMs = Date.now()): Promise<boolean> {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SVIX_TOLERANCE_S) return false;
  let keyBytes: Uint8Array;
  try { keyBytes = b64ToBytes(secret.replace(/^whsec_/, '')); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = bytesToB64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return signatureHeader.split(' ').some((part) => { const [v, sig] = part.split(','); return v === 'v1' && !!sig && safeEqual(sig, expected); });
}

export const senderAddress = (from: unknown): string => {
  const s = typeof from === 'string' ? from : from && typeof from === 'object' ? String((from as any).email ?? (from as any).address ?? '') : '';
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
};

// "bidnet.com" allows anyone@bidnet.com and anyone@mail.bidnet.com; "boss@example.com" allows only that address
export function senderAllowed(address: string, list: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  const domain = address.slice(at + 1);
  return list.split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).some((raw) => {
    const rule = raw.startsWith('@') ? raw.slice(1) : raw;               // "@bidnet.com" and "bidnet.com" both mean the domain
    return rule.includes('@') ? rule === address : domain === rule || domain.endsWith('.' + rule);
  });
}

const htmlToPlain = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|tr|h[1-6]|table)\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

type Mail = { messageId: string | null; from: string; subject: string; body: string };

async function parseMail(payload: any, fetchResendBody: (id: string) => Promise<{ text?: string; html?: string } | null>): Promise<Mail | { error: string }> {
  if (payload?.type === 'email.received' && payload.data) {           // Resend inbound: the webhook has no body, fetch it
    const d = payload.data;
    const full = d.email_id ? await fetchResendBody(String(d.email_id)) : null;
    const body = full?.text || (full?.html ? htmlToPlain(full.html) : '') || (typeof d.text === 'string' ? d.text : '');
    if (!body) return { error: 'Could not read the email body from Resend.' };
    return { messageId: String(d.message_id ?? d.email_id ?? ''), from: senderAddress(d.from), subject: String(d.subject ?? ''), body };
  }
  if (payload && ('TextBody' in payload || 'HtmlBody' in payload || 'FromFull' in payload)) {   // Postmark
    const body = payload.TextBody || (payload.HtmlBody ? htmlToPlain(payload.HtmlBody) : '');
    return { messageId: payload.MessageID ? String(payload.MessageID) : null, from: senderAddress(payload.FromFull?.Email ?? payload.From), subject: String(payload.Subject ?? ''), body };
  }
  if (payload && typeof payload === 'object' && (payload.text || payload.html)) {                // generic
    const body = payload.text || htmlToPlain(String(payload.html));
    return { messageId: payload.message_id ? String(payload.message_id) : null, from: senderAddress(payload.from), subject: String(payload.subject ?? ''), body };
  }
  return { error: 'Unrecognised email format.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 2_000_000) return json({ error: 'Too large' }, 413);

    // ── who is calling? ─────────────────────────────────────────────────────
    const svixSecret = Deno.env.get('RESEND_WEBHOOK_SECRET');
    const sharedSecret = Deno.env.get('INBOUND_EMAIL_SECRET');
    const url = new URL(req.url);
    const presented = req.headers.get('x-inbound-secret') ?? url.searchParams.get('token') ?? '';
    const viaShared = !!sharedSecret && safeEqual(presented, sharedSecret);
    const viaSvix = !!svixSecret && req.headers.has('svix-signature') &&
      await verifySvix(svixSecret, req.headers.get('svix-id') ?? '', req.headers.get('svix-timestamp') ?? '', req.headers.get('svix-signature') ?? '', raw);
    if (!viaShared && !viaSvix) return json({ error: 'Not authorized' }, 401);

    let payload: any;
    try { payload = JSON.parse(raw); } catch { return json({ error: 'Not JSON' }, 400); }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const fetchResendBody = async (id: string) => {
      const key = Deno.env.get('RESEND_API_KEY');
      if (!key) return null;
      try {
        const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    };
    const mail = await parseMail(payload, fetchResendBody);
    if ('error' in mail) return json({ ok: false, accepted: false, reason: mail.error }, 400);

    // ── allow-list, daily cap, duplicate check ────────────────────────────────
    const { data: settingRows } = await admin.from('bid_settings').select('key, value');
    const allowList = (settingRows ?? []).find((r: { key: string }) => r.key === 'email_senders')?.value ?? '';
    if (!senderAllowed(mail.from, allowList)) return json({ ok: true, accepted: false, reason: 'Sender is not on the allowed list.' });

    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const { data: todays } = await admin.from('bid_inbox').select('id').gte('received_at', startOfDay);
    if ((todays ?? []).length >= MAX_PER_DAY) return json({ ok: true, accepted: false, reason: 'Daily limit of stored emails reached.' });

    const { error } = await admin.from('bid_inbox').insert({
      message_id: mail.messageId || null, sender: mail.from.slice(0, 200), subject: mail.subject.slice(0, 300), body: mail.body.slice(0, MAX_BODY_CHARS), status: 'queued',
    });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return json({ ok: true, accepted: false, reason: 'Already received.' });
      return json({ error: 'Could not store the email.' }, 500);
    }
    return json({ ok: true, accepted: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
