// Runs the real bids-inbound Edge Function: signature checks, allow-list, queueing, de-duplication, limits.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const h = vi.hoisted(() => ({ handler: null, env: {}, db: null, resendBody: null }));

const reset = () => {
  h.env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', INBOUND_EMAIL_SECRET: 'shared-secret-xyz', RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('svix-test-key-bytes').toString('base64')}`, RESEND_API_KEY: 're_test' };
  h.db = { bid_settings: [{ key: 'email_senders', value: 'bidnet.example, boss@example.com' }], bid_inbox: [] };
  h.resendBody = { text: 'Fire hose bid for Riverside FD', html: null };
};

const makeAdmin = () => ({
  from: (table) => {
    let op = 'select'; let payload; let gte;
    const api = {
      select: () => api, gte: (k, v) => { gte = [k, v]; return api; }, insert: (p) => { op = 'insert'; payload = p; return api; },
      then: (res, rej) => (async () => {
        if (op === 'insert') {
          if (payload.message_id && h.db[table].some((r) => r.message_id === payload.message_id)) return { error: { message: 'duplicate key value violates unique constraint' } };
          h.db[table].push({ id: h.db[table].length + 1, received_at: new Date().toISOString(), ...payload }); return { error: null };
        }
        const rows = gte ? h.db[table].filter((r) => String(r[gte[0]]) >= gte[1]) : h.db[table];
        return { data: rows, error: null };
      })().then(res, rej),
    };
    return api;
  },
});

beforeAll(async () => {
  globalThis.__fakeCreateClient = () => makeAdmin();
  globalThis.Deno = { env: { get: (k) => h.env[k] }, serve: (fn) => { h.handler = fn; } };
  globalThis.__mod = await import('../functions/bids-inbound/index.ts');
});
beforeEach(() => {
  reset();
  globalThis.fetch = vi.fn(async (url) => ({ ok: !!h.resendBody, status: h.resendBody ? 200 : 404, json: async () => h.resendBody }));
});

const post = async (body, headers = {}, url = 'http://fn/') => {
  const res = await h.handler(new Request(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};
const shared = { 'x-inbound-secret': 'shared-secret-xyz' };
const generic = (o = {}) => ({ from: 'Alerts <alerts@bidnet.example>', subject: 'New fire bids', text: 'SCBA packs bid due Dec 10', message_id: `<m-${Math.random()}>`, ...o });
const svixHeaders = (raw, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), key = 'svix-test-key-bytes' } = {}) => ({
  'svix-id': id, 'svix-timestamp': String(ts),
  'svix-signature': `v1,${createHmac('sha256', Buffer.from(key)).update(`${id}.${ts}.${raw}`).digest('base64')}`,
});

describe('who may call', () => {
  it('rejects callers with no secret, a wrong secret or a bad signature', async () => {
    expect((await post(generic())).status).toBe(401);
    expect((await post(generic(), { 'x-inbound-secret': 'wrong' })).status).toBe(401);
    const raw = JSON.stringify(generic());
    expect((await post(raw, svixHeaders(raw, { key: 'someone-elses-key' }))).status).toBe(401);
    expect(h.db.bid_inbox).toHaveLength(0);
  });
  it('accepts the shared secret in a header or in the URL', async () => {
    expect((await post(generic(), shared)).json.accepted).toBe(true);
    expect((await post(generic(), {}, 'http://fn/?token=shared-secret-xyz')).json.accepted).toBe(true);
  });
  it('rejects when no secret is configured at all (an empty secret never matches)', async () => {
    delete h.env.INBOUND_EMAIL_SECRET; delete h.env.RESEND_WEBHOOK_SECRET;
    expect((await post(generic(), { 'x-inbound-secret': '' })).status).toBe(401);
    expect((await post(generic())).status).toBe(401);
  });
  it('accepts a correctly signed Resend (Svix) webhook, and refuses stale or tampered ones', async () => {
    const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'e1', from: 'alerts@bidnet.example', subject: 'Fire hose bid', message_id: '<r1>' } });
    const ok = await post(raw, svixHeaders(raw));
    expect(ok.status).toBe(200);
    expect(ok.json.accepted).toBe(true);
    expect(h.db.bid_inbox[0]).toMatchObject({ sender: 'alerts@bidnet.example', subject: 'Fire hose bid', body: 'Fire hose bid for Riverside FD', status: 'queued' });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.resend.com/emails/receiving/e1', expect.objectContaining({ headers: { Authorization: 'Bearer re_test' } }));
    expect((await post(raw, svixHeaders(raw, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await post(raw + ' ', svixHeaders(raw))).status).toBe(401);
  });
  it('only takes POST', async () => {
    const res = await h.handler(new Request('http://fn/', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});

describe('payload formats', () => {
  it('reads Postmark inbound JSON and HTML-only emails', async () => {
    await post({ From: 'x', FromFull: { Email: 'Alerts@BidNet.example' }, Subject: 'Postmark bid', TextBody: 'turnout gear bid', MessageID: 'pm-1' }, shared);
    await post(generic({ text: undefined, html: '<p>Fire <b>hose</b> bid</p><script>x()</script>', message_id: '<h1>' }), shared);
    expect(h.db.bid_inbox[0]).toMatchObject({ sender: 'alerts@bidnet.example', subject: 'Postmark bid', body: 'turnout gear bid' });
    expect(h.db.bid_inbox[1].body).toBe('Fire hose bid');
  });
  it('rejects unrecognised or unreadable emails with a reason', async () => {
    expect((await post({ hello: 'world' }, shared)).status).toBe(400);
    expect((await post('not json', shared)).status).toBe(400);
    h.resendBody = null;
    const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'e2', from: 'alerts@bidnet.example' } });
    const r = await post(raw, svixHeaders(raw));
    expect(r.status).toBe(400);
    expect(r.json.reason).toMatch(/body/);
  });
});

describe('allow-list, limits and duplicates', () => {
  it('accepts only listed domains (and their subdomains) and addresses', async () => {
    expect((await post(generic({ from: 'a@bidnet.example' }), shared)).json.accepted).toBe(true);
    expect((await post(generic({ from: 'a@mail.bidnet.example' }), shared)).json.accepted).toBe(true);
    expect((await post(generic({ from: 'Boss <boss@example.com>' }), shared)).json.accepted).toBe(true);
    for (const from of ['a@evilbidnet.example', 'a@bidnet.example.evil.com', 'other@example.com', 'no-at-sign', '']) {
      const r = await post(generic({ from }), shared);
      expect(r.json.accepted, from).toBe(false);
    }
    expect(h.db.bid_inbox).toHaveLength(3);
  });
  it('accepts nothing while the allow-list is empty', async () => {
    h.db.bid_settings[0].value = '';
    expect((await post(generic(), shared)).json).toMatchObject({ accepted: false, reason: expect.stringMatching(/allowed list/) });
    expect(h.db.bid_inbox).toHaveLength(0);
  });
  it('ignores a message it has already received', async () => {
    const m = generic({ message_id: '<same>' });
    expect((await post(m, shared)).json.accepted).toBe(true);
    const again = await post(m, shared);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ accepted: false, reason: 'Already received.' });
    expect(h.db.bid_inbox).toHaveLength(1);
  });
  it('stops storing after 300 emails a day and truncates huge bodies', async () => {
    h.db.bid_inbox = Array.from({ length: 300 }, (_, i) => ({ id: i, received_at: new Date().toISOString() }));
    expect((await post(generic(), shared)).json.reason).toMatch(/Daily limit/);
    h.db.bid_inbox = [];
    await post(generic({ text: 'x'.repeat(500_000) }), shared);
    expect(h.db.bid_inbox[0].body).toHaveLength(100_000);
  });
});

describe('helpers', () => {
  it('parses sender addresses', () => {
    const { senderAddress, senderAllowed } = globalThis.__mod;
    expect(senderAddress('Name <A@B.com>')).toBe('a@b.com');
    expect(senderAddress({ email: 'X@Y.org' })).toBe('x@y.org');
    expect(senderAllowed('a@b.com', '@b.com')).toBe(true);
    expect(senderAllowed('a@b.com', 'c.com; d.com')).toBe(false);
  });
});
