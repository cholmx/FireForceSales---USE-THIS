// Main-admin-only user management. Needs service-role access, so it cannot run in the browser.
// Levels: owner = "Main Admin" (the only one who can call this), office = "Office Admin", salesman = "Sales".
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ASSIGNABLE = ['office', 'salesman']; // the main admin can hand out these two levels
const safeRedirect = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: 'Not authenticated' }, 401);
    const { data: me } = await admin.from('users_ff2024').select('role').eq('auth_id', caller.user.id).maybeSingle();
    if (me?.role !== 'owner') return json({ error: 'Only the main admin can manage users' }, 403);

    const body = await req.json();

    // ── create (with a password, or by sending an invite email) ───────────────
    if (body.action === 'create') {
      const { name, phone, password } = body;
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = ASSIGNABLE.includes(body.role) ? body.role : 'salesman';
      const invite = body.invite === true;
      if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address' }, 400);
      if (!invite && (!password || password.length < 8)) return json({ error: 'A password of 8+ characters is required' }, 400);

      let authId: string;
      if (invite) {
        const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: safeRedirect(body.redirectTo) });
        if (error) return json({ error: error.message }, 400);
        authId = invited.user.id;
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
      return json({ user: data });
    }

    const { data: target } = await admin.from('users_ff2024').select('id, auth_id, role, email').eq('id', body.id).maybeSingle();
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

    // ── resend an invite email (only works while the person hasn't accepted yet) ─
    if (body.action === 'resend_invite') {
      if (!target.email) return json({ error: 'This user has no email address' }, 400);
      const { error } = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo: safeRedirect(body.redirectTo) });
      if (error) {
        return json({ error: /registered|exists/i.test(error.message)
          ? 'This person has already set up their account. Ask them to use "Forgot password?" on the sign-in page.'
          : error.message }, 400);
      }
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
