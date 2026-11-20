// Runs the real bids-daily Edge Function against a fake Supabase admin client, a fake feed server and a fake Resend.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ handler: null, env: {}, db: null, rpcCalls: [], callerAuthId: 'auth-sales' }));

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const lead = (o = {}) => ({
  id: `l-${Math.random().toString(36).slice(2, 8)}`, agency_name: 'Test FD', city: 'Town', county: 'Stark', state: 'OH', solicitation_number: null,
  due_date: inDays(30), grant_funded: false, status: 'New', summary: '', items: [{ item_name: 'SCBA', quantity: 4 }],
  sources: [{ source: 'Paper', url: 'https://news.example/a' }], categories: ['SCBA'], is_sample: false,
  first_seen_at: new Date().toISOString(), ...o,
});

const reset = () => {
  h.env = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'svc', BIDS_CRON_SECRET: 'cron-secret-123', RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Fire Force <noreply@fforcesales.com>', APP_URL: 'https://app.example.com' };
  h.rpcCalls = [];
  h.callerAuthId = 'auth-sales';
  h.db = {
    bid_settings: [{ key: 'feed_url', value: '/data/fire_equipment_leads.json' }, { key: 'digest_enabled', value: 'true' }],
    bid_digests: [],
    bid_leads: [],
    bid_counties: [{ state: 'OH', county: 'Stark' }, { state: 'OH', county: 'Columbiana' }, { state: 'PA', county: 'Erie' }],
    users_ff2024: [
      { id: 'u1', auth_id: 'auth-owner', role: 'owner', email: 'boss@example.com' },
      { id: 'u2', auth_id: 'auth-office', role: 'office', email: 'Office@Example.com' },
      { id: 'u3', auth_id: 'auth-sales', role: 'salesman', email: 'sales@example.com' },
      { id: 'u4', auth_id: 'auth-legacy', role: 'salesman', email: 'old@fireforce.local' },
      { id: 'u5', auth_id: null, role: 'salesman', email: 'noauth@example.com' },
      { id: 'u6', auth_id: 'auth-dup', role: 'salesman', email: 'sales@example.com' },
    ],
  };
};

const makeAdmin = () => ({
  auth: { getUser: async (t) => (t === 'jwt' ? { data: { user: { id: h.callerAuthId } } } : { data: { user: null } }) },
  rpc: async (name, args) => {
    h.rpcCalls.push([name, args]);
    return { data: { inserted: args.p_leads.length, merged: 0, skipped: 0, errors: [] }, error: null };
  },
  from: (table) => {
    const filters = []; let op = 'select'; let payload;
    const rows = () => h.db[table].filter((r) => filters.every(([k, v]) => r[k] === v));
    const api = {
      select: () => api, eq: (k, v) => { filters.push([k, v]); return api; },
      insert: (p) => { op = 'insert'; payload = p; return api; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res, rej) => (async () => {
        if (op === 'insert') { h.db[table].push({ sent_at: new Date().toISOString(), ...payload }); return { error: null }; }
        return { data: rows(), error: null };
      })().then(res, rej),
    };
    return api;
  },
});

const resend = []; let resendStatus = 200; let feedHandler;
beforeAll(async () => {
  globalThis.__fakeCreateClient = () => makeAdmin();
  globalThis.Deno = { env: { get: (k) => h.env[k] }, serve: (fn) => { h.handler = fn; } };
  globalThis.__mod = await import('../functions/bids-daily/index.ts');
});

beforeEach(() => {
  reset(); resend.length = 0; resendStatus = 200;
  feedHandler = () => ({ status: 200, body: JSON.stringify([{ agency_name: 'Feed FD', state: 'OH' }]) });
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    if (String(url).startsWith('https://api.resend.com/emails/batch')) {
      resend.push(JSON.parse(init.body));
      return { ok: resendStatus < 300, status: resendStatus, text: async () => 'domain not verified' };
    }
    const r = feedHandler(String(url));
    return { ok: r.status < 300, status: r.status, headers: { get: (k) => (r.headers ?? {})[k.toLowerCase()] ?? null }, text: async () => r.body };
  });
});

const call = async (body, headers = {}) => {
  const res = await h.handler(new Request('http://fn', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};
const asCron = { 'x-cron-secret': 'cron-secret-123' };
const asUser = (id) => { h.callerAuthId = id; return { Authorization: 'Bearer jwt' }; };
const allMails = () => resend.flat();

describe('who may call what', () => {
  it('rejects anonymous callers and a wrong cron secret', async () => {
    expect((await call({ action: 'daily' })).status).toBe(401);
    expect((await call({ action: 'daily' }, { 'x-cron-secret': 'nope' })).status).toBe(401);
  });
  it('lets Sales refresh the feed but not run the daily check, send the digest or push leads', async () => {
    const sales = asUser('auth-sales');
    expect((await call({ action: 'refresh_feed', origin: 'https://app.example.com' }, sales)).status).toBe(200);
    expect((await call({ action: 'daily' }, sales)).status).toBe(403);
    expect((await call({ action: 'digest' }, sales)).status).toBe(403);
    expect((await call({ action: 'ingest', leads: [] }, sales)).status).toBe(403);
  });
  it('lets an Office Admin run the daily check, and the cron secret run everything', async () => {
    expect((await call({ action: 'digest' }, asUser('auth-office'))).status).toBe(200);
    expect((await call({ action: 'daily' }, asCron)).status).toBe(200);
  });
  it('rejects a signed-in account with no staff profile', async () => {
    expect((await call({ action: 'refresh_feed' }, asUser('auth-stranger'))).status).toBe(403);
  });
  it('rejects unknown actions', async () => {
    expect((await call({ action: 'wipe' }, asCron)).status).toBe(400);
  });
});

describe('ingest', () => {
  it('imports pushed leads in chunks of 500', async () => {
    const leads = Array.from({ length: 1200 }, (_, i) => ({ agency_name: `FD ${i}`, state: 'OH' }));
    const r = await call({ action: 'ingest', leads }, asCron);
    expect(r.json.import).toMatchObject({ inserted: 1200 });
    expect(h.rpcCalls.map(([, a]) => a.p_leads.length)).toEqual([500, 500, 200]);
    expect(h.rpcCalls.every(([n, a]) => n === 'import_bid_leads' && a.p_mark_sample === false)).toBe(true);
  });
  it('requires an array', async () => {
    expect((await call({ action: 'ingest', leads: 'x' }, asCron)).status).toBe(400);
  });
});

describe('feed import', () => {
  it('resolves the default relative feed against the app address and imports it', async () => {
    const r = await call({ action: 'refresh_feed', origin: 'https://app.example.com' }, asUser('auth-sales'));
    expect(globalThis.fetch).toHaveBeenCalledWith('https://app.example.com/data/fire_equipment_leads.json', expect.anything());
    expect(r.json.feed).toMatchObject({ ok: true, found: 1, inserted: 1 });
  });
  it('accepts { leads: [...] } as well as a bare array', async () => {
    feedHandler = () => ({ status: 200, body: JSON.stringify({ leads: [{ agency_name: 'A', state: 'OH' }, { agency_name: 'B', state: 'PA' }] }) });
    const r = await call({ action: 'refresh_feed' }, asUser('auth-sales'));
    expect(r.json.feed.found).toBe(2);
  });
  it('reports a bad feed instead of failing', async () => {
    feedHandler = () => ({ status: 500, body: '' });
    expect((await call({ action: 'refresh_feed' }, asUser('auth-sales'))).json.feed.error).toMatch(/500/);
    feedHandler = () => ({ status: 200, body: '<html>' });
    expect((await call({ action: 'refresh_feed' }, asUser('auth-sales'))).json.feed.error).toMatch(/not valid JSON/);
    feedHandler = () => ({ status: 200, body: '{"nope":1}' });
    expect((await call({ action: 'refresh_feed' }, asUser('auth-sales'))).json.feed.error).toMatch(/array/);
  });
  it('does nothing when no feed is configured', async () => {
    h.db.bid_settings = [];
    const r = await call({ action: 'refresh_feed' }, asUser('auth-sales'));
    expect(r.json.feed.skipped).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('refuses a feed setting that points at an internal address', async () => {
    h.db.bid_settings = [{ key: 'feed_url', value: 'http://169.254.169.254/latest/meta-data' }];
    const r = await call({ action: 'refresh_feed' }, asUser('auth-sales'));
    expect(r.json.feed.error).toMatch(/not allowed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('refuses a redirect to an internal address', async () => {
    h.db.bid_settings = [{ key: 'feed_url', value: 'https://feeds.example.com/leads.json' }];
    feedHandler = () => ({ status: 302, headers: { location: 'http://10.0.0.5/secret' }, body: '' });
    const r = await call({ action: 'refresh_feed' }, asUser('auth-sales'));
    expect(r.json.feed.error).toMatch(/not allowed/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('follows a normal public redirect', async () => {
    h.db.bid_settings = [{ key: 'feed_url', value: 'http://feeds.example.com/leads.json' }];
    let n = 0;
    feedHandler = () => (n++ === 0 ? { status: 301, headers: { location: 'https://feeds.example.com/leads.json' }, body: '' } : { status: 200, body: '[{"agency_name":"X","state":"OH"}]' });
    expect((await call({ action: 'refresh_feed' }, asUser('auth-sales'))).json.feed.found).toBe(1);
  });
});

describe('isSafeFeedUrl', () => {
  it('blocks private, loopback, link-local and odd URLs and allows public ones', () => {
    const ok = globalThis.__mod.isSafeFeedUrl;
    for (const bad of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://172.16.0.1/x', 'http://192.168.1.1/x',
      'http://169.254.169.254/x', 'http://0.0.0.0/x', 'http://[::1]/x', 'http://foo.internal/x', 'http://printer.local/x',
      'file:///etc/passwd', 'ftp://example.com/x', 'https://user:pw@example.com/x', 'not a url']) {
      expect(ok(bad), bad).toBe(false);
    }
    for (const good of ['https://example.com/feed.json', 'http://feeds.example.org/a?b=1', 'https://172.15.0.1/x', 'https://8.8.8.8/x']) {
      expect(ok(good), good).toBe(true);
    }
  });
});

describe('digest', () => {
  it('emails each recipient separately, only real staff addresses, deduplicated', async () => {
    h.db.bid_leads = [lead({ agency_name: 'Alpha FD' })];
    const r = await call({ action: 'digest', origin: 'https://app.example.com' }, asCron);
    expect(r.json.digest).toMatchObject({ sent: true, newLeads: 1, recipients: 3 });
    const mails = allMails();
    expect(mails.map((m) => m.to).sort()).toEqual([['boss@example.com'], ['office@example.com'], ['sales@example.com']].sort());
    expect(mails.every((m) => m.to.length === 1)).toBe(true);
    expect(mails[0].subject).toMatch(/Fire Force bids: 1 new/);
    expect(mails[0].html).toContain('Alpha FD');
    expect(mails[0].html).toContain('https://app.example.com/bids');
  });
  it('leaves out samples, outside-area, Passed and already-emailed leads, but keeps unknown-county ones', async () => {
    h.db.bid_leads = [
      lead({ agency_name: 'In Area FD' }),
      lead({ agency_name: 'Unknown County FD', county: null }),
      lead({ agency_name: 'Sample FD', is_sample: true }),
      lead({ agency_name: 'Outside FD', county: 'Franklin' }),
      lead({ agency_name: 'Out Of State FD', state: 'MI' }),
      lead({ agency_name: 'Passed FD', status: 'Passed' }),
    ];
    await call({ action: 'digest' }, asCron);
    const html = allMails()[0].html;
    expect(html).toContain('In Area FD');
    expect(html).toContain('Unknown County FD');
    expect(html).toContain('county not confirmed');
    for (const hidden of ['Sample FD', 'Outside FD', 'Out Of State FD', 'Passed FD']) expect(html).not.toContain(hidden);
  });
  it('does not email the same leads twice, and logs the send', async () => {
    h.db.bid_leads = [lead()];
    await call({ action: 'digest' }, asCron);
    expect(h.db.bid_digests).toHaveLength(1);
    expect(h.db.bid_digests[0]).toMatchObject({ leads: 1, recipients: 3, triggered_by: 'schedule' });
    resend.length = 0;
    const again = await call({ action: 'digest' }, asCron);
    expect(again.json.digest).toMatchObject({ sent: false });
    expect(resend).toHaveLength(0);
  });
  it('records who triggered a manual send', async () => {
    h.db.bid_leads = [lead()];
    await call({ action: 'digest' }, asUser('auth-office'));
    expect(h.db.bid_digests[0].triggered_by).toBe('manual');
  });
  it('adds a reminder for older leads due within 7 days that are still open', async () => {
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    h.db.bid_digests = [{ sent_at: new Date(Date.now() - 86400000).toISOString() }];
    h.db.bid_leads = [
      lead({ agency_name: 'Soon FD', due_date: inDays(3), first_seen_at: old }),
      lead({ agency_name: 'Soon But Quoted FD', due_date: inDays(3), first_seen_at: old, status: 'Quoted' }),
      lead({ agency_name: 'Later FD', due_date: inDays(20), first_seen_at: old }),
    ];
    await call({ action: 'digest' }, asCron);
    const mail = allMails()[0];
    expect(mail.subject).toMatch(/0 new, 1 due soon/);
    expect(mail.html).toContain('Soon FD');
    expect(mail.html).not.toContain('Quoted FD');
    expect(mail.html).not.toContain('Later FD');
  });
  it('sends nothing when there is nothing new and nothing due', async () => {
    const r = await call({ action: 'digest' }, asCron);
    expect(r.json.digest.sent).toBe(false);
    expect(resend).toHaveLength(0);
  });
  it('respects the switch in settings', async () => {
    h.db.bid_settings = [{ key: 'digest_enabled', value: 'false' }];
    h.db.bid_leads = [lead()];
    const r = await call({ action: 'digest' }, asCron);
    expect(r.json.digest.sent).toBe(false);
    expect(resend).toHaveLength(0);
  });
  it('caps the list at 40 and says how many more there are', async () => {
    h.db.bid_leads = Array.from({ length: 45 }, (_, i) => lead({ agency_name: `Dept ${i}` }));
    await call({ action: 'digest' }, asCron);
    const mail = allMails()[0];
    expect(mail.subject).toMatch(/45 new/);
    expect(mail.html).toContain('and 5 more');
    expect((mail.html.match(/Dept \d+/g) ?? []).length).toBe(40);
  });
  it('escapes lead text and only links web addresses', async () => {
    h.db.bid_leads = [lead({ agency_name: '<script>x</script>', sources: [{ source: 'Bad', url: 'javascript:alert(1)' }, { source: 'Good', url: 'https://ok.example/a' }] })];
    await call({ action: 'digest' }, asCron);
    const html = allMails()[0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://ok.example/a');
  });
  it('keeps the leads for tomorrow if Resend fails, without leaking the key', async () => {
    h.db.bid_leads = [lead()];
    resendStatus = 403;
    const r = await call({ action: 'digest' }, asCron);
    expect(r.json.digest).toMatchObject({ sent: false });
    expect(r.json.digest.error).toMatch(/403/);
    expect(JSON.stringify(r.json)).not.toContain('re_test_key');
    expect(h.db.bid_digests).toHaveLength(0);
  });
  it('explains when email is not configured', async () => {
    delete h.env.RESEND_API_KEY;
    h.db.bid_leads = [lead()];
    const r = await call({ action: 'digest' }, asCron);
    expect(r.json.digest.error).toMatch(/RESEND_API_KEY/);
    expect(h.db.bid_digests).toHaveLength(0);
  });
});

describe('daily', () => {
  it('imports the feed first, then sends the digest', async () => {
    h.db.bid_leads = [lead()];
    const r = await call({ action: 'daily', origin: 'https://app.example.com' }, asCron);
    expect(r.json.feed).toMatchObject({ ok: true, found: 1 });
    expect(r.json.digest.sent).toBe(true);
    expect(h.rpcCalls).toHaveLength(1);
  });
  it('still sends the digest when the feed is down', async () => {
    feedHandler = () => ({ status: 503, body: '' });
    h.db.bid_leads = [lead()];
    const r = await call({ action: 'daily', origin: 'https://app.example.com' }, asCron);
    expect(r.json.feed.ok).toBe(false);
    expect(r.json.digest.sent).toBe(true);
  });
});
