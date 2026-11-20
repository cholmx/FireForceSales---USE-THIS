// User management + account emails (invites, password resets) sent through Resend.
//
// Public action (no sign-in):   request_reset    "Forgot password?" on the sign-in page
// Main-admin-only actions:      create, update, resend_invite, delete
// Levels: owner = "Main Admin", office = "Office Admin", salesman = "Sales".
//
// Secrets (Supabase -> Edge Functions -> Secrets; never commit them):
//   RESEND_API_KEY   required to send any email
//   EMAIL_FROM       e.g. "Fire Force <noreply@fforce.com>" (must be on a domain verified in Resend).
//                    Defaults to Resend's sandbox sender, which only delivers to your own Resend account email.
//   EMAIL_REPLY_TO   optional, e.g. fireforceinfo@gmail.com
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LEGACY_DOMAIN = '@fireforce.local'; // synthetic logins from before email sign-in; can't receive mail
const ASSIGNABLE = ['office', 'salesman']; // the main admin can hand out these two levels
const ROLE_LABELS: Record<string, string> = { owner: 'Main Admin', office: 'Office Admin', salesman: 'Sales' };
const safeRedirect = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined);

// ── email ────────────────────────────────────────────────────────────────────
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

type Sent = { ok: true } | { ok: false; error: string };

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<Sent> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'Email is not set up yet (the RESEND_API_KEY secret is missing).' };
  const from = Deno.env.get('EMAIL_FROM') || 'Fire Force <onboarding@resend.dev>';
  const replyTo = Deno.env.get('EMAIL_REPLY_TO');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `Resend refused the email (${res.status}). ${detail}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach Resend: ${e}` };
  }
}

function buildEmail(opts: { heading: string; intro: string; button: string; link: string; footnote: string }) {
  const { heading, intro, button, link, footnote } = opts;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:10px;border-top:4px solid #C81E1E">
<tr><td style="padding:28px 32px">
<div style="font-size:20px;font-weight:800;letter-spacing:.02em">FIRE FORCE</div>
<div style="font-size:12px;color:#6b7280;margin-bottom:20px">Fire Safety Equipment Sales &amp; Service</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h1>
<p style="font-size:14px;line-height:1.5;margin:0 0 22px">${esc(intro)}</p>
<p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#C81E1E;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:8px">${esc(button)}</a></p>
<p style="font-size:12px;line-height:1.5;color:#6b7280;margin:0 0 6px">${esc(footnote)}</p>
<p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:0;word-break:break-all">If the button doesn't work, copy this link into your browser:<br>${esc(link)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}\n\n${button}: ${link}\n\n${footnote}`;
  return { html, text };
}

const inviteEmail = (name: string | null, role: string, link: string) =>
  buildEmail({
    heading: "You've been invited to Fire Force",
    intro: `${name ? `Hi ${name}, y` : 'Y'}ou now have ${ROLE_LABELS[role] ?? 'an'} access to the Fire Force sales system. Choose a password to finish setting up your account.`,
    button: 'Set your password',
    link,
    footnote: 'For your security this link expires soon and only works once. If it has expired, ask the main admin to send a new invite.',
  });

const resetEmail = (link: string) =>
  buildEmail({
    heading: 'Reset your Fire Force password',
    intro: 'We received a request to reset the password for your Fire Force account. Click below to choose a new one.',
    button: 'Choose a new password',
    link,
    footnote: "If you didn't ask for this, you can ignore this email; your password won't change.",
  });

// Best-effort brake on repeat reset requests (instances are short-lived, so this only softens bursts)
const recentResets = new Map<string, number>();
const RESET_COOLDOWN_MS = 60_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json();

    // ── PUBLIC: forgot password ────────────────────────────────────────────────
    // Always answers "ok" so it can't be used to discover who has an account.
    if (body.action === 'request_reset') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.endsWith(LEGACY_DOMAIN)) return json({ ok: true });
      if (Date.now() - (recentResets.get(email) ?? 0) < RESET_COOLDOWN_MS) return json({ ok: true });
      recentResets.set(email, Date.now());

      const { data: row } = await admin.from('users_ff2024').select('auth_id').eq('email', email).maybeSingle();
      if (!row?.auth_id) return json({ ok: true });
      const { data: au } = await admin.auth.admin.getUserById(row.auth_id);
      // only ever mail the address the account actually signs in with
      if (!au?.user?.email || au.user.email.toLowerCase() !== email) return json({ ok: true });
      const lastSent = au.user.recovery_sent_at ? Date.parse(au.user.recovery_sent_at) : 0;
      if (Date.now() - lastSent < RESET_COOLDOWN_MS) return json({ ok: true });

      const { data: link, error } = await admin.auth.admin.generateLink({
        type: 'recovery', email, options: { redirectTo: safeRedirect(body.redirectTo) },
      });
      const actionLink = link?.properties?.action_link;
      if (error || !actionLink) { console.error('reset link failed', error?.message); return json({ ok: true }); }
      const m = resetEmail(actionLink);
      const sent = await sendEmail(email, 'Reset your Fire Force password', m.html, m.text);
      if (!sent.ok) console.error('reset email failed:', sent.error);
      return json({ ok: true });
    }

    // ── everything below: the main admin only ─────────────────────────────────
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: 'Not authenticated' }, 401);
    const { data: me } = await admin.from('users_ff2024').select('role').eq('auth_id', caller.user.id).maybeSingle();
    if (me?.role !== 'owner') return json({ error: 'Only the main admin can manage users' }, 403);

    // ── create (with a password, or by emailing an invite) ────────────────────
    if (body.action === 'create') {
      const { name, phone, password } = body;
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = ASSIGNABLE.includes(body.role) ? body.role : 'salesman';
      const invite = body.invite === true;
      if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address' }, 400);
      if (!invite && (!password || password.length < 8)) return json({ error: 'A password of 8+ characters is required' }, 400);

      let authId: string;
      let inviteLink: string | undefined;
      if (invite) {
        // generateLink creates the (unconfirmed) account and returns the link without emailing anything;
        // we send the email ourselves through Resend.
        const { data: gen, error } = await admin.auth.admin.generateLink({
          type: 'invite', email, options: { redirectTo: safeRedirect(body.redirectTo) },
        });
        if (error) return json({ error: error.message }, 400);
        authId = gen.user.id;
        inviteLink = gen.properties.action_link;
      } else {
        const { data: created, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { must_change_password: true }, // temp password: they must pick their own
        });
        if (error) return json({ error: error.message }, 400);
        authId = created.user.id;
      }
      // users_ff2024.username is legacy; keep it equal to the email so the unique column never collides
      const { data, error: dbErr } = await admin.from('users_ff2024')
        .insert({ username: email, name, email, phone, role, auth_id: authId })
        .select('id, username, name, email, phone, role').single();
      if (dbErr) { await admin.auth.admin.deleteUser(authId); return json({ error: dbErr.message }, 400); }

      if (!invite) return json({ user: data });
      const m = inviteEmail(name ?? null, role, inviteLink!);
      const sent = await sendEmail(email, "You've been invited to Fire Force", m.html, m.text);
      // The account exists either way; tell the caller if the email didn't go out so they can re-send.
      return json({ user: data, emailSent: sent.ok, ...(sent.ok ? {} : { emailError: sent.error }) });
    }

    const { data: target } = await admin.from('users_ff2024').select('id, auth_id, role, email, name').eq('id', body.id).maybeSingle();
    if (!target) return json({ error: 'User not found' }, 404);
    const isSelf = target.auth_id === caller.user.id;

    // ── update (details, email = sign-in, password, level) ────────────────────
    if (body.action === 'update') {
      const { name, phone, password } = body;
      const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
      if (email && !EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address' }, 400);
      if (password && password.length < 8) return json({ error: 'Password must be 8+ characters' }, 400);

      const row: Record<string, unknown> = { name, phone };
      if (body.role !== undefined && body.role !== target.role) {
        if (target.role === 'owner' || isSelf) return json({ error: "The main admin's level can't be changed" }, 400);
        if (!ASSIGNABLE.includes(body.role)) return json({ error: 'Choose Office Admin or Sales' }, 400);
        row.role = body.role;
      }

      if (target.auth_id && (password || email)) {
        const attrs: Record<string, unknown> = {};
        if (password) {
          attrs.password = password;
          // An admin-set password is temporary: force a change at next sign-in (unless resetting your own)
          if (!isSelf) attrs.user_metadata = { must_change_password: true };
        }
        if (email) { attrs.email = email; attrs.email_confirm = true; } // changing the email changes the sign-in
        const { error } = await admin.auth.admin.updateUserById(target.auth_id, attrs);
        if (error) return json({ error: error.message }, 400);
      }
      if (email) { row.email = email; row.username = email; }
      const { error } = await admin.from('users_ff2024').update(row).eq('id', target.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ── resend an invite (only while the person hasn't signed in yet) ─────────
    if (body.action === 'resend_invite') {
      if (!target.auth_id) return json({ error: 'This user has no login to invite' }, 400);
      const { data: au } = await admin.auth.admin.getUserById(target.auth_id);
      const email = au?.user?.email?.toLowerCase();
      if (!email || email.endsWith(LEGACY_DOMAIN)) return json({ error: 'This account has no real email address yet. Edit the user and add one first.' }, 400);
      if (au?.user?.last_sign_in_at) {
        return json({ error: 'This person has already set up their account. Ask them to use "Forgot password?" on the sign-in page.' }, 400);
      }
      const { data: gen, error } = await admin.auth.admin.generateLink({
        type: 'recovery', email, options: { redirectTo: safeRedirect(body.redirectTo) },
      });
      if (error || !gen?.properties?.action_link) return json({ error: error?.message ?? 'Could not create the invite link' }, 400);
      const m = inviteEmail(target.name ?? null, target.role, gen.properties.action_link);
      const sent = await sendEmail(email, "You've been invited to Fire Force", m.html, m.text);
      if (!sent.ok) return json({ error: sent.error }, 502);
      return json({ ok: true });
    }

    // ── delete ────────────────────────────────────────────────────────────────
    if (body.action === 'delete') {
      if (isSelf) return json({ error: 'You cannot delete yourself' }, 400);
      if (target.role === 'owner') return json({ error: 'The main admin cannot be deleted' }, 400);
      const { error } = target.auth_id
        ? await admin.auth.admin.deleteUser(target.auth_id) // cascades to users_ff2024
        : await admin.from('users_ff2024').delete().eq('id', target.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
