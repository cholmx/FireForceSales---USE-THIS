// Office-only user management. Needs service-role access, so it cannot run in the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: 'Not authenticated' }, 401);
    const { data: me } = await admin.from('users_ff2024').select('role').eq('auth_id', caller.user.id).maybeSingle();
    if (me?.role !== 'office') return json({ error: 'Forbidden' }, 403);

    const body = await req.json();
    const emailFor = (u: string) => `${u.trim().toLowerCase()}@fireforce.local`;

    if (body.action === 'create') {
      const { username, name, email, phone, password } = body;
      const role = body.role === 'office' ? 'office' : 'salesman';
      if (!username || !password || password.length < 8) return json({ error: 'Username and a password of 8+ characters are required' }, 400);
      const { data: created, error } = await admin.auth.admin.createUser({
        email: emailFor(username), password, email_confirm: true,
        user_metadata: { must_change_password: true }, // temp password: user must pick their own
      });
      if (error) return json({ error: error.message }, 400);
      const { data, error: dbErr } = await admin.from('users_ff2024')
        .insert({ username: username.trim().toLowerCase(), name, email, phone, role, auth_id: created.user.id })
        .select('id, username, name, email, phone, role').single();
      if (dbErr) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: dbErr.message }, 400); }
      return json({ user: data });
    }

    const { data: target } = await admin.from('users_ff2024').select('id, auth_id, role').eq('id', body.id).maybeSingle();
    if (!target) return json({ error: 'User not found' }, 404);

    if (body.action === 'update') {
      const { name, email, phone, password } = body;
      if (password) {
        if (password.length < 8) return json({ error: 'Password must be 8+ characters' }, 400);
        // An admin-set password is temporary: force a change at next sign-in (unless resetting your own)
        const { error } = await admin.auth.admin.updateUserById(target.auth_id, {
          password,
          ...(target.auth_id !== caller.user.id ? { user_metadata: { must_change_password: true } } : {}),
        });
        if (error) return json({ error: error.message }, 400);
      }
      const { error } = await admin.from('users_ff2024').update({ name, email, phone }).eq('id', target.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (body.action === 'delete') {
      if (target.auth_id === caller.user.id) return json({ error: 'You cannot delete yourself' }, 400);
      if (target.role === 'office') {
        const { count } = await admin.from('users_ff2024').select('id', { count: 'exact', head: true }).eq('role', 'office');
        if ((count ?? 0) <= 1) return json({ error: 'Cannot delete the last office account' }, 400);
      }
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
