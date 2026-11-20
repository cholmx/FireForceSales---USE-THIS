// Runs the real Edge Function (supabase/functions/manage-users/index.ts) against a fake Supabase admin client
// and a fake Resend, so permissions and email behaviour are checked without Deno or network access.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null,
  env: {},
  db: null,       // { rows: [...], authUsers: Map }
  calls: [],      // admin.auth.admin.* calls, in order
  callerAuthId: 'auth-owner',
  genLinkError: null,
}));

const resetState = () => {
  h.env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Fire Force <noreply@fforce.com>', EMAIL_REPLY_TO: 'fireforceinfo@gmail.com' };
  h.calls = [];
  h.callerAuthId = 'auth-owner';
  h.genLinkError = null;
  h.db = {
    rows: [
      { id: 'u-owner', auth_id: 'auth-owner', role: 'owner', email: 'fireforceinfo@gmail.com', name: 'Boss', username: 'fireforceinfo@gmail.com' },
      { id: 'u-office', auth_id: 'auth-office', role: 'office', email: 'office@example.com', name: 'Olive', username: 'office@example.com' },
      { id: 'u-sales', auth_id: 'auth-sales', role: 'salesman', email: 'sales@example.com', name: 'Sam <b>', username: 'sales@example.com' },
      { id: 'u-pending', auth_id: 'auth-pending', role: 'salesman', email: 'pending@example.com', name: 'Pat', username: 'pending@example.com' },
      { id: 'u-legacy', auth_id: 'auth-legacy', role: 'salesman', email: 'legacy@fireforce.local', name: 'Lee', username: 'legacy' },
    ],
    authUsers: new Map([
      ['auth-owner', { id: 'auth-owner', email: 'fireforceinfo@gmail.com', last_sign_in_at: '2026-11-01' }],
      ['auth-office', { id: 'auth-office', email: 'office@example.com', last_sign_in_at: '2026-11-01' }],
      ['auth-sales', { id: 'auth-sales', email: 'sales@example.com', last_sign_in_at: '2026-11-01' }],
      ['auth-pending', { id: 'auth-pending', email: 'pending@example.com', last_sign_in_at: null }],
      ['auth-legacy', { id: 'auth-legacy', email: 'legacy@fireforce.local', last_sign_in_at: null }],
    ]),
  };
};

const makeAdmin = () => {
  const table = () => {
    let op = 'select'; let payload; const filters = [];
    const matches = () => h.db.rows.filter((r) => filters.every(([k, v]) => r[k] === v));
    const run = async () => {
      if (op === 'update') { matches().forEach((r) => Object.assign(r, payload)); return { error: null }; }
      if (op === 'delete') { const m = matches(); h.db.rows = h.db.rows.filter((r) => !m.includes(r)); return { error: null }; }
      return { error: null };
    };
    const api = {
      select: () => api,
      insert: (p) => { op = 'insert'; payload = p; return api; },
      update: (p) => { op = 'update'; payload = p; return api; },
      delete: () => { op = 'delete'; return api; },
      eq: (k, v) => { filters.push([k, v]); return api; },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      single: async () => {
        if (op === 'insert') { const row = { id: `u-${h.db.rows.length + 1}`, ...payload }; h.db.rows.push(row); return { data: row, error: null }; }
        return { data: matches()[0] ?? null, error: null };
      },
      then: (res, rej) => run().then(res, rej),
    };
    return api;
  };
  const rec = (name, fn) => async (args) => { h.calls.push([name, args]); return fn(args); };
  return {
    auth: {
      getUser: async (token) => (token === 'good-token' ? { data: { user: { id: h.callerAuthId } } } : { data: { user: null } }),
      admin: {
        getUserById: rec('getUserById', async (id) => ({ data: { user: h.db.authUsers.get(id) ?? null }, error: null })),
        createUser: rec('createUser', async (a) => { const u = { id: `auth-${a.email}`, email: a.email }; h.db.authUsers.set(u.id, u); return { data: { user: u }, error: null }; }),
        generateLink: rec('generateLink', async (a) => {
          if (h.genLinkError) return { data: null, error: { message: h.genLinkError } };
          let u = [...h.db.authUsers.values()].find((x) => x.email === a.email);
          if (!u) { u = { id: `auth-${a.email}`, email: a.email, last_sign_in_at: null }; h.db.authUsers.set(u.id, u); }
          return { data: { user: u, properties: { action_link: `https://proj.supabase.co/auth/v1/verify?token=T&type=${a.type}` } }, error: null };
        }),
        updateUserById: async (id, attrs) => { h.calls.push(['updateUserById', { id, ...attrs }]); return { error: null }; },
        deleteUser: rec('deleteUser', async (id) => { h.db.authUsers.delete(id); h.db.rows = h.db.rows.filter((r) => r.auth_id !== id); return { error: null }; }),
      },
    },
    from: () => table(),
  };
};

const sent = []; // emails handed to Resend

beforeAll(async () => {
  globalThis.__fakeCreateClient = () => makeAdmin();
  globalThis.Deno = { env: { get: (k) => h.env[k] }, serve: (fn) => { h.handler = fn; } };
  await import('../functions/manage-users/index.ts');
});

let resendStatus = 200;
beforeEach(() => {
  resetState();
  sent.length = 0;
  resendStatus = 200;
  globalThis.fetch = vi.fn(async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: resendStatus < 300, status: resendStatus, text: async () => (resendStatus < 300 ? '' : 'domain not verified') };
  });
});

let n = 0;
const call = async (body, { token = 'good-token' } = {}) => {
  // unique emails per request so the in-function reset cooldown never bleeds between tests
  n += 1;
  const res = await h.handler(new Request('http://fn', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json(), n };
};

describe('access control', () => {
  it('rejects callers who are not signed in', async () => {
    const r = await call({ action: 'create', email: 'a@b.co', invite: true }, { token: 'bad' });
    expect(r.status).toBe(401);
  });
  it('rejects an Office Admin and Sales', async () => {
    for (const id of ['auth-office', 'auth-sales']) {
      h.callerAuthId = id;
      const r = await call({ action: 'create', email: 'new@example.com', password: 'longenough' });
      expect(r.status).toBe(403);
    }
    expect(h.calls.find(([name]) => name === 'createUser')).toBeUndefined();
  });
});

describe('create', () => {
  it('creates a user with a temporary password and no email', async () => {
    const r = await call({ action: 'create', email: ' New@Example.com ', name: 'New', role: 'office', password: 'longenough' });
    expect(r.status).toBe(200);
    expect(h.calls.find(([n]) => n === 'createUser')[1]).toMatchObject({ email: 'new@example.com', user_metadata: { must_change_password: true } });
    expect(h.db.rows.find((x) => x.email === 'new@example.com')).toMatchObject({ role: 'office', username: 'new@example.com' });
    expect(sent).toHaveLength(0);
  });
  it('never lets the owner level be handed out', async () => {
    await call({ action: 'create', email: 'sneak@example.com', role: 'owner', password: 'longenough' });
    expect(h.db.rows.find((x) => x.email === 'sneak@example.com').role).toBe('salesman');
  });
  it('invite: creates the account and emails the link through Resend', async () => {
    const r = await call({ action: 'create', email: 'invitee@example.com', name: 'Ivy', role: 'salesman', invite: true, redirectTo: 'https://app.example.com' });
    expect(r.json).toMatchObject({ emailSent: true, user: { email: 'invitee@example.com', role: 'salesman' } });
    expect(h.calls.find(([n]) => n === 'generateLink')[1]).toMatchObject({ type: 'invite', email: 'invitee@example.com', options: { redirectTo: 'https://app.example.com' } });
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.url).toBe('https://api.resend.com/emails');
    expect(mail.headers.Authorization).toBe('Bearer re_test_key');
    expect(mail.body).toMatchObject({ from: 'Fire Force <noreply@fforce.com>', to: ['invitee@example.com'], reply_to: 'fireforceinfo@gmail.com' });
    expect(mail.body.html).toContain('type=invite');
    expect(mail.body.html).toContain('Sales');
    expect(mail.body.text).toContain('https://proj.supabase.co/auth/v1/verify');
  });
  it('invite: keeps the account but reports it when email is not configured', async () => {
    delete h.env.RESEND_API_KEY;
    const r = await call({ action: 'create', email: 'noemail@example.com', invite: true });
    expect(r.status).toBe(200);
    expect(r.json.emailSent).toBe(false);
    expect(r.json.emailError).toMatch(/RESEND_API_KEY/);
    expect(h.db.rows.some((x) => x.email === 'noemail@example.com')).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('invite: reports a Resend rejection without leaking the API key', async () => {
    resendStatus = 403;
    const r = await call({ action: 'create', email: 'rejected@example.com', invite: true });
    expect(r.json.emailSent).toBe(false);
    expect(r.json.emailError).toMatch(/403/);
    expect(JSON.stringify(r.json)).not.toContain('re_test_key');
  });
  it('escapes names in the email HTML', async () => {
    await call({ action: 'create', email: 'xss@example.com', name: '<script>alert(1)</script>', invite: true });
    expect(sent[0].body.html).not.toContain('<script>');
    expect(sent[0].body.html).toContain('&lt;script&gt;');
  });
});

describe('update and delete', () => {
  it('lets the owner move someone between Office Admin and Sales, but not change the owner or themselves', async () => {
    expect((await call({ action: 'update', id: 'u-sales', role: 'office' })).status).toBe(200);
    expect(h.db.rows.find((r) => r.id === 'u-sales').role).toBe('office');
    expect((await call({ action: 'update', id: 'u-owner', role: 'salesman' })).status).toBe(400);
    expect((await call({ action: 'update', id: 'u-sales', role: 'owner' })).status).toBe(400);
  });
  it('changing an email changes the sign-in and keeps username in sync', async () => {
    await call({ action: 'update', id: 'u-owner', email: 'New.Boss@Example.com' });
    expect(h.calls.find(([n]) => n === 'updateUserById')[1]).toMatchObject({ email: 'new.boss@example.com', email_confirm: true });
    expect(h.db.rows.find((r) => r.id === 'u-owner')).toMatchObject({ email: 'new.boss@example.com', username: 'new.boss@example.com' });
  });
  it('an admin-set password for someone else is temporary; your own is not', async () => {
    await call({ action: 'update', id: 'u-sales', password: 'longenough' });
    await call({ action: 'update', id: 'u-owner', password: 'longenough' });
    const [other, self] = h.calls.filter(([n]) => n === 'updateUserById').map(([, a]) => a);
    expect(other.user_metadata).toEqual({ must_change_password: true });
    expect(self.user_metadata).toBeUndefined();
  });
  it('protects the owner and yourself from deletion, allows deleting others', async () => {
    expect((await call({ action: 'delete', id: 'u-owner' })).status).toBe(400);
    expect((await call({ action: 'delete', id: 'u-sales' })).status).toBe(200);
    expect(h.db.rows.some((r) => r.id === 'u-sales')).toBe(false);
  });
});

describe('resend_invite', () => {
  it('emails a fresh link to someone who has not signed in yet', async () => {
    const r = await call({ action: 'resend_invite', id: 'u-pending', redirectTo: 'https://app.example.com' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(['pending@example.com']);
  });
  it('refuses for someone who is already active, pointing them to Forgot password', async () => {
    const r = await call({ action: 'resend_invite', id: 'u-sales' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Forgot password/);
    expect(sent).toHaveLength(0);
  });
  it('refuses accounts that only have a legacy @fireforce.local login', async () => {
    const r = await call({ action: 'resend_invite', id: 'u-legacy' });
    expect(r.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe('request_reset (public)', () => {
  const reset = (email) => call({ action: 'request_reset', email, redirectTo: 'https://app.example.com' }, { token: 'anon-key-only' });

  it('emails a reset link to a known account, with no sign-in required', async () => {
    const r = await reset('sales@example.com');
    expect(r.json).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ to: ['sales@example.com'], subject: 'Reset your Fire Force password' });
    expect(h.calls.find(([n]) => n === 'generateLink')[1]).toMatchObject({ type: 'recovery' });
  });
  it('answers ok but sends nothing for an unknown address', async () => {
    const r = await reset('stranger@example.com');
    expect(r.json).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });
  it('sends nothing to legacy @fireforce.local logins or malformed input', async () => {
    await reset('legacy@fireforce.local');
    await reset('not-an-email');
    expect(sent).toHaveLength(0);
  });
  it("won't mail an address that isn't the account's actual sign-in email", async () => {
    h.db.authUsers.get('auth-sales').email = 'different-login@example.com'; // profile email no longer matches the login
    await reset('sales@example.com');
    expect(sent).toHaveLength(0);
  });
  it('does not send twice in quick succession', async () => {
    await reset('office@example.com');
    await reset('office@example.com');
    expect(sent).toHaveLength(1);
  });
  it('does not expose any other action without owner sign-in', async () => {
    const r = await call({ action: 'delete', id: 'u-sales' }, { token: 'anon-key-only' });
    expect(r.status).toBe(401);
  });
});
