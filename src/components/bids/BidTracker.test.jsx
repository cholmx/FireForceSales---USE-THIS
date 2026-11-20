// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ bids: null, user: { id: 'u1', isOffice: true } }));
vi.mock('./useBids', () => ({ useBids: () => h.bids }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('../../lib/supabase', () => ({
  default: { from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ sent_at: '2026-11-19T12:00:00Z', leads: 3, recipients: 5, triggered_by: 'schedule' }] }) }) }) }) },
}));

import BidTracker from './BidTracker';
import { countySet, todayISO } from './bidUtils';

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return todayISO(d); };
const lead = (o) => ({
  id: o.agency_name, agency_name: 'X', city: 'Town', county: 'Stark', state: 'OH', solicitation_number: null, due_date: inDays(30), grant_funded: false,
  status: 'New', summary: '', items: [], sources: [], categories: ['Other'], notes: '', is_sample: false, first_seen_at: '2026-11-10T00:00:00Z', ...o,
});

const makeBids = (leads, over = {}) => ({
  leads, counties: [{ state: 'OH', county: 'Stark' }, { state: 'OH', county: 'Columbiana' }, { state: 'PA', county: 'Erie' }],
  countyKeys: countySet([{ state: 'OH', county: 'Stark' }, { state: 'OH', county: 'Columbiana' }, { state: 'PA', county: 'Erie' }]),
  settings: { feed_url: '/data/fire_equipment_leads.json', digest_enabled: 'true' }, loading: false, error: '', feedStatus: { state: 'idle', message: '' }, lastUpdated: 0,
  reload: vi.fn(), importLeads: vi.fn(), loadSamples: vi.fn().mockResolvedValue({}), updateLead: vi.fn().mockResolvedValue(), deleteLeads: vi.fn().mockResolvedValue(1),
  saveSettings: vi.fn().mockResolvedValue(),
  extractText: vi.fn(), getFinderStatus: vi.fn().mockResolvedValue({ ai: true, sam: false, aiUsedToday: 3, aiDailyCap: 150, watchedPages: 1, queuedEmails: 2 }),
  runDiscovery: vi.fn().mockResolvedValue({ report: { sam: { skipped: true, reason: 'No SAM_API_KEY secret is set.' }, pages: { checked: 1, found: 2, inserted: 1, problems: 0 }, email: { processed: 1, found: 0 } } }),
  checkPage: vi.fn().mockResolvedValue({ pages: { found: 1 } }), addPage: vi.fn().mockResolvedValue(), updatePage: vi.fn().mockResolvedValue(), deletePage: vi.fn().mockResolvedValue(),
  loadPages: vi.fn().mockResolvedValue([
    { id: 'p1', name: 'Stark Twp Fire', url: 'https://stark.example/bids', state: 'OH', county: 'Stark', active: true, last_checked_at: '2026-11-19T12:00:00Z', last_status: 'Found 1 open bid (1 new, 0 already known)' },
    { id: 'p2', name: 'Old Page', url: 'https://old.example', state: 'PA', county: null, active: false, last_checked_at: null, last_status: null },
  ]),
  loadInbox: vi.fn().mockResolvedValue([{ id: 1, received_at: '2026-11-19T10:00:00Z', sender: 'alerts@bidnet.example', subject: 'New fire bids', status: 'processed', leads_found: 2, note: '' }]),
  refreshFeed: vi.fn().mockResolvedValue({ feed: { ok: true, inserted: 2, merged: 1 } }), runDaily: vi.fn(), ...over,
});

const LEADS = [
  lead({ agency_name: 'Alpha FD', due_date: inDays(5), grant_funded: true, status: 'Reviewing', city: 'Canton',
    items: [{ item_name: 'SCBA packs', quantity: 12, preferred_brands: ['MSA'], nfpa_standards: ['NFPA 1981'] }], categories: ['SCBA'],
    sources: [{ source: 'Repository', url: 'https://news.example/a' }, { source: 'Evil', url: 'javascript:alert(1)' }], notes: 'Called chief' }),
  lead({ agency_name: 'Beta FD', due_date: inDays(20), county: 'Columbiana', categories: ['Turnout Gear'], items: [{ item_name: 'Bunker gear', quantity: 40 }] }),
  lead({ agency_name: 'Gamma FD', county: null, due_date: null }),
  lead({ agency_name: 'Old FD', due_date: inDays(-3) }),
  lead({ agency_name: 'Outside FD', county: 'Franklin' }),
];

beforeEach(() => { h.user = { id: 'u1', isOffice: true }; h.bids = makeBids(LEADS); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rows = () => screen.queryAllByTestId('bid-row').map((r) => r.textContent);

describe('FireBid Tracker', () => {
  it('shows metrics for open bids in our counties', () => {
    render(<BidTracker />);
    const metric = (label) => screen.getByText(label).parentElement.textContent;
    expect(metric('Active leads')).toContain('3');            // Alpha, Beta, Gamma (closed + outside excluded)
    expect(metric('Due within 14 days')).toContain('1');
    expect(metric('Grant-funded')).toContain('1');
    expect(metric('Reviewing or quoted')).toContain('1');
  });

  it('hides closed and outside bids by default, and reveals them on request', () => {
    render(<BidTracker />);
    for (const name of ['Alpha FD', 'Beta FD', 'Gamma FD']) expect(rows().some((r) => r.startsWith(name))).toBe(true);
    expect(rows().join()).not.toContain('Old FD');
    expect(rows().join()).not.toContain('Outside FD');
    fireEvent.click(screen.getByLabelText('Show closed'));
    expect(rows().join()).toContain('Old FD');
    fireEvent.change(screen.getByLabelText('Service area'), { target: { value: 'outside' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Outside FD');
  });

  it('sorts soonest due first and flags unconfirmed counties', () => {
    render(<BidTracker />);
    expect(rows()[0]).toContain('Alpha FD');
    expect(rows().at(-1)).toContain('Gamma FD');
    expect(rows().at(-1)).toContain('County?');
  });

  it('searches brands and NFPA codes, and filters by state, county and equipment', () => {
    render(<BidTracker />);
    fireEvent.change(screen.getByLabelText('Search bids'), { target: { value: 'nfpa 1981' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search bids'), { target: { value: '' } });
    expect(screen.getByLabelText('County').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'OH' } });
    fireEvent.change(screen.getByLabelText('County'), { target: { value: 'Columbiana' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Beta FD');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Equipment category'), { target: { value: 'SCBA' } });
    expect(rows()[0]).toContain('Alpha FD');
    expect(rows()).toHaveLength(1);
  });

  it('changes status from the table without opening the details', () => {
    render(<BidTracker />);
    fireEvent.change(screen.getByLabelText('Status for Beta FD'), { target: { value: 'Quoted' } });
    expect(h.bids.updateLead).toHaveBeenCalledWith('Beta FD', { status: 'Quoted' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a detail panel with items, standards, brands and only safe source links', () => {
    render(<BidTracker />);
    fireEvent.click(screen.getAllByTestId('bid-row')[0]);
    const dialog = screen.getByRole('dialog', { name: /Alpha FD/ });
    expect(within(dialog).getByText('SCBA packs')).toBeTruthy();
    expect(within(dialog).getAllByText('NFPA 1981').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('link', { name: 'Repository' }).getAttribute('href')).toBe('https://news.example/a');
    expect(within(dialog).queryByText('Evil')).toBeNull();
    expect(within(dialog).getByLabelText(/Team notes/).value).toBe('Called chief');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves shared notes', async () => {
    render(<BidTracker />);
    fireEvent.click(screen.getAllByTestId('bid-row')[0]);
    fireEvent.change(screen.getByLabelText(/Team notes/), { target: { value: 'Quote sent Friday' } });
    fireEvent.click(screen.getByText('Save notes'));
    await waitFor(() => expect(h.bids.updateLead).toHaveBeenCalledWith('Alpha FD', { notes: 'Quote sent Friday' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('lets office staff delete a bid (after confirming) but not Sales', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BidTracker />);
    fireEvent.click(screen.getAllByTestId('bid-row')[0]);
    fireEvent.click(screen.getByText('Delete this bid'));
    await waitFor(() => expect(h.bids.deleteLeads).toHaveBeenCalledWith({ id: 'Alpha FD' }));
    cleanup();
    h.user = { id: 'u2', isOffice: false };
    render(<BidTracker />);
    fireEvent.click(screen.getAllByTestId('bid-row')[0]);
    expect(screen.queryByText('Delete this bid')).toBeNull();
  });

  it('refreshes the feed and reports what it found', async () => {
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Refresh Feed'));
    expect(await screen.findByText(/2 new, 1 merged/)).toBeTruthy();
  });

  it('shows an empty state with sample data on a fresh board', async () => {
    h.bids = makeBids([]);
    render(<BidTracker />);
    expect(screen.getByText('No bids yet')).toBeTruthy();
    fireEvent.click(screen.getByText('Load sample data'));
    await waitFor(() => expect(h.bids.loadSamples).toHaveBeenCalled());
  });

  it('shows a retry when loading fails', () => {
    h.bids = makeBids([], { error: 'boom' });
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Try again'));
    expect(h.bids.reload).toHaveBeenCalled();
  });

  it('adds a bid from the form through the import function', async () => {
    h.bids.importLeads.mockResolvedValue({ inserted: 1, merged: 0, skipped: 0, errors: [] });
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Add / Import'));
    fireEvent.change(screen.getByLabelText('Agency *'), { target: { value: 'New FD' } });
    fireEvent.change(screen.getByLabelText(/one per line/), { target: { value: 'SCBA packs x4' } });
    fireEvent.click(screen.getByText('Add bid'));
    await waitFor(() => expect(h.bids.importLeads).toHaveBeenCalled());
    const [sent] = h.bids.importLeads.mock.calls[0];
    expect(sent[0]).toMatchObject({ agency_name: 'New FD', state: 'OH' });
    expect(sent[0].items[0]).toMatchObject({ item_name: 'SCBA packs', quantity: 4 });
    expect(await screen.findByText(/1 added/)).toBeTruthy();
  });

  it('imports pasted JSON and explains bad JSON', async () => {
    h.bids.importLeads.mockResolvedValue({ inserted: 2, merged: 0, skipped: 0, errors: [] });
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Add / Import'));
    fireEvent.click(screen.getByText('Paste or upload JSON'));
    fireEvent.change(screen.getByLabelText('Leads JSON'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Import'));
    expect(await screen.findByText(/not valid JSON/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Leads JSON'), { target: { value: '[{"agency_name":"A","state":"OH"},{"agency_name":"B","state":"PA"}]' } });
    fireEvent.click(screen.getByText('Import'));
    await waitFor(() => expect(h.bids.importLeads).toHaveBeenCalledWith([{ agency_name: 'A', state: 'OH' }, { agency_name: 'B', state: 'PA' }]));
  });

  it('only offers "Remove sample data" to office staff', () => {
    h.user = { id: 'u2', isOffice: false };
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Add / Import'));
    fireEvent.click(screen.getByText('Sample data'));
    expect(screen.queryByText('Remove sample data')).toBeNull();
  });

  it('lets office staff save feed settings, and keeps them read-only for Sales', async () => {
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Feed Settings'));
    fireEvent.change(screen.getByLabelText('JSON feed URL'), { target: { value: ' https://feeds.example.com/bids.json ' } });
    fireEvent.click(screen.getByLabelText(/Email a daily digest/));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(h.bids.saveSettings).toHaveBeenCalledWith({ feed_url: 'https://feeds.example.com/bids.json', digest_enabled: false }));
    expect(await screen.findByText(/Last digest/)).toBeTruthy();
    cleanup();
    h.user = { id: 'u2', isOffice: false };
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Feed Settings'));
    expect(screen.getByLabelText('JSON feed URL').disabled).toBe(true);
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.getByText(/Only office staff can change/)).toBeTruthy();
  });

  it('reads a pasted notice with AI and lists what it found', async () => {
    h.bids.extractText.mockResolvedValue({ found: 1, ignored: 1, import: { inserted: 1, merged: 0 }, leads: [{ agency_name: 'Riverside FD', county: 'Stark', state: 'OH', due_date: '2026-12-10', items: [{ item_name: 'SCBA packs' }] }] });
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Add / Import'));
    fireEvent.click(screen.getByText('Paste a notice (AI)'));
    expect(screen.getByText('Read this notice').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Notice text'), { target: { value: 'LEGAL NOTICE: Riverside Township seeks sealed bids for SCBA packs.' } });
    fireEvent.change(screen.getByLabelText('Where it came from'), { target: { value: 'Morning Journal' } });
    fireEvent.click(screen.getByText('Read this notice'));
    await waitFor(() => expect(h.bids.extractText).toHaveBeenCalledWith({ text: 'LEGAL NOTICE: Riverside Township seeks sealed bids for SCBA packs.', sourceName: 'Morning Journal', sourceUrl: undefined }));
    expect(await screen.findByText(/Found 1 bid: 1 added, 0 merged/)).toBeTruthy();
    expect(screen.getByText('Riverside FD')).toBeTruthy();
  });

  it('says so plainly when the notice has no open fire-equipment bid, and shows AI errors', async () => {
    h.bids.extractText.mockResolvedValueOnce({ found: 0, ignored: 2, import: null, leads: [] });
    render(<BidTracker />);
    fireEvent.click(screen.getByText('Add / Import'));
    fireEvent.click(screen.getByText('Paste a notice (AI)'));
    fireEvent.change(screen.getByLabelText('Notice text'), { target: { value: 'City council minutes about parks and the budget.' } });
    fireEvent.click(screen.getByText('Read this notice'));
    expect(await screen.findByText(/didn't find an open fire-equipment bid/)).toBeTruthy();
    h.bids.extractText.mockRejectedValueOnce(new Error('The daily AI limit (150) has been reached.'));
    fireEvent.click(screen.getByText('Read this notice'));
    expect(await screen.findByText(/daily AI limit/)).toBeTruthy();
  });

  it('only shows the Sources button to office staff', () => {
    render(<BidTracker />);
    expect(screen.getByRole('button', { name: 'Sources' })).toBeTruthy();
    cleanup();
    h.user = { id: 'u2', isOffice: false };
    render(<BidTracker />);
    expect(screen.queryByRole('button', { name: 'Sources' })).toBeNull();
  });

  describe('Sources window', () => {
    const open = async () => { render(<BidTracker />); fireEvent.click(screen.getByRole('button', { name: 'Sources' })); await screen.findByText('Public pages we watch'); await screen.findByText('Stark Twp Fire'); };

    it('shows what is switched on and what is missing', async () => {
      await open();
      expect(await screen.findByText(/AI reading is on \(3 of 150 reads used today\)/)).toBeTruthy();
      expect(screen.getByText(/SAM.gov is off: add the SAM_API_KEY secret/)).toBeTruthy();
      expect(screen.getByText(/1 page watched · 2 emails waiting/)).toBeTruthy();
    });

    it('warns when AI reading is not configured', async () => {
      h.bids.getFinderStatus.mockResolvedValue({ ai: false, sam: true, aiUsedToday: 0, aiDailyCap: 150, watchedPages: 0, queuedEmails: 0 });
      await open();
      expect(await screen.findByText(/AI reading is off: add the ANTHROPIC_API_KEY secret/)).toBeTruthy();
    });

    it('lists watched pages with their last result and marks paused ones', async () => {
      await open();
      const rows = screen.getAllByTestId('watch-row');
      expect(rows[0].textContent).toContain('Found 1 open bid');
      expect(rows[1].textContent).toContain('Not checked yet');
      expect(rows[1].className).toMatch(/opacity-50/);
      expect(screen.getByText('Resume')).toBeTruthy();
    });

    it('adds a page, but refuses a non-web address', async () => {
      await open();
      const win = within(screen.getByRole('dialog', { name: 'Bid sources' }));
      fireEvent.change(win.getByLabelText('Name *'), { target: { value: 'Beaver Co' } });
      fireEvent.change(win.getByLabelText('Page address *'), { target: { value: 'javascript:alert(1)' } });
      fireEvent.click(win.getByText('Add page'));
      expect(h.bids.addPage).not.toHaveBeenCalled();
      fireEvent.change(win.getByLabelText('Page address *'), { target: { value: 'https://beaver.example/rfp' } });
      fireEvent.change(win.getByLabelText('State'), { target: { value: 'PA' } });
      fireEvent.change(win.getByLabelText('County'), { target: { value: 'Beaver' } });
      fireEvent.click(win.getByText('Add page'));
      await waitFor(() => expect(h.bids.addPage).toHaveBeenCalledWith({ name: 'Beaver Co', url: 'https://beaver.example/rfp', state: 'PA', county: 'Beaver' }));
    });

    it('checks, pauses, resumes and removes pages', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await open();
      fireEvent.click(screen.getAllByText('Check now')[0]);
      await waitFor(() => expect(h.bids.checkPage).toHaveBeenCalledWith('p1'));
      fireEvent.click(screen.getByText('Pause'));
      await waitFor(() => expect(h.bids.updatePage).toHaveBeenCalledWith('p1', { active: false }));
      fireEvent.click(screen.getByText('Resume'));
      await waitFor(() => expect(h.bids.updatePage).toHaveBeenCalledWith('p2', { active: true }));
      fireEvent.click(screen.getAllByText('Remove')[0]);
      await waitFor(() => expect(h.bids.deletePage).toHaveBeenCalledWith('p1'));
    });

    it('does not remove a page when the confirmation is declined', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await open();
      fireEvent.click(screen.getAllByText('Remove')[0]);
      expect(h.bids.deletePage).not.toHaveBeenCalled();
    });

    it('saves SAM.gov and email settings', async () => {
      await open();
      fireEvent.click(screen.getByLabelText('Check SAM.gov every day'));
      fireEvent.change(screen.getByLabelText(/Keywords/), { target: { value: ' SCBA, hose ' } });
      fireEvent.change(screen.getByLabelText(/Alert address/), { target: { value: 'bids@fforcesales.com' } });
      fireEvent.change(screen.getByLabelText(/Allowed senders/), { target: { value: 'bidnet.com, boss@example.com' } });
      fireEvent.click(screen.getByText('Save settings'));
      await waitFor(() => expect(h.bids.saveSettings).toHaveBeenCalledWith({ sam_enabled: false, sam_keywords: 'SCBA, hose', inbound_address: 'bids@fforcesales.com', email_senders: 'bidnet.com, boss@example.com' }));
    });

    it('warns that no alert emails are accepted until senders are listed, and shows recent emails', async () => {
      await open();
      expect(screen.getByText(/No senders listed, so no alert emails are accepted yet/)).toBeTruthy();
      expect(await screen.findByLabelText('Recent alert emails')).toBeTruthy();
      expect(screen.getByText(/New fire bids/).closest('li').textContent).toContain('processed · 2 bids');
    });

    it('runs discovery now and summarises every source, including failures', async () => {
      await open();
      fireEvent.click(screen.getByText('Look for bids now'));
      expect(await screen.findByText(/SAM.gov skipped \(No SAM_API_KEY secret is set\.\)/)).toBeTruthy();
      expect(screen.getByText(/Pages: 1 checked, 2 bids found \(1 new\)/)).toBeTruthy();
      h.bids.runDiscovery.mockRejectedValueOnce(new Error('Only office staff can do that'));
      fireEvent.click(screen.getByText('Look for bids now'));
      expect(await screen.findByText(/Only office staff can do that/)).toBeTruthy();
    });
  });
});
