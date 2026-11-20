import { describe, it, expect } from 'vitest';
import {
  areaOf, countySet, daysUntil, dueInfo, isClosed, computeMetrics, filterLeads, sortLeads, DEFAULT_FILTERS,
  parseLeadsJson, parseItemLines, leadFromForm, safeUrl, nfpaOf, brandsOf, itemSummary,
} from './bidUtils';

const set = countySet([{ state: 'OH', county: 'Stark' }, { state: 'OH', county: 'Columbiana' }, { state: 'WV', county: 'Ohio' }, { state: 'PA', county: 'Erie' }]);
const TODAY = '2026-11-20';
const L = (o) => ({ id: Math.random(), agency_name: 'A FD', state: 'OH', county: 'Stark', status: 'New', grant_funded: false, due_date: '2026-12-31', items: [], categories: ['Other'], summary: '', ...o });

describe('service area', () => {
  it('flags in / unknown / outside', () => {
    expect(areaOf(L({}), set)).toBe('in');
    expect(areaOf(L({ county: 'STARK' }), set)).toBe('in');
    expect(areaOf(L({ county: null }), set)).toBe('unknown');
    expect(areaOf(L({ county: 'Franklin' }), set)).toBe('outside');
    expect(areaOf(L({ state: 'MI', county: 'Wayne' }), set)).toBe('outside');
    expect(areaOf(L({ state: 'WV', county: 'Ohio' }), set)).toBe('in');
    expect(areaOf(L({ state: 'PA', county: 'Stark' }), set)).toBe('outside');
  });
});

describe('due dates', () => {
  it('counts days and picks a tone', () => {
    expect(daysUntil('2026-11-27', TODAY)).toBe(7);
    expect(dueInfo(L({ due_date: '2026-11-20' }), TODAY).tone).toBe('urgent');
    expect(dueInfo(L({ due_date: '2026-11-25' }), TODAY)).toMatchObject({ tone: 'urgent' });
    expect(dueInfo(L({ due_date: '2026-12-01' }), TODAY).tone).toBe('soon');
    expect(dueInfo(L({ due_date: '2027-03-01' }), TODAY).tone).toBe('normal');
    expect(dueInfo(L({ due_date: '2026-11-01' }), TODAY).tone).toBe('closed');
    expect(dueInfo(L({ due_date: null }), TODAY)).toEqual({ label: 'No due date', tone: 'none' });
  });
  it('treats past-due and Passed as closed', () => {
    expect(isClosed(L({ due_date: '2026-11-19' }), TODAY)).toBe(true);
    expect(isClosed(L({ status: 'Passed' }), TODAY)).toBe(true);
    expect(isClosed(L({ due_date: null }), TODAY)).toBe(false);
    expect(isClosed(L({ due_date: TODAY }), TODAY)).toBe(false);
  });
});

describe('metrics', () => {
  it('counts only open, in-service-area leads', () => {
    const leads = [
      L({ due_date: '2026-11-25', grant_funded: true, status: 'Reviewing' }),
      L({ due_date: '2026-12-30', status: 'Quoted' }),
      L({ due_date: null }),
      L({ due_date: '2026-11-01' }),                   // closed
      L({ status: 'Passed' }),                          // closed
      L({ county: 'Franklin', due_date: '2026-11-25' }), // outside
    ];
    expect(computeMetrics(leads, TODAY, set)).toEqual({ active: 3, due14: 1, grant: 1, inProgress: 2 });
  });
});

describe('filter and sort', () => {
  const leads = [
    L({ agency_name: 'Zeta FD', due_date: '2026-12-20', items: [{ item_name: 'SCBA packs', quantity: 10, preferred_brands: ['MSA'], nfpa_standards: ['NFPA 1981'] }], categories: ['SCBA'], grant_funded: true }),
    L({ agency_name: 'Alpha FD', due_date: '2026-11-30', city: 'Canton', categories: ['Turnout Gear'], status: 'Reviewing', summary: 'bunker coats' }),
    L({ agency_name: 'No Date FD', due_date: null }),
    L({ agency_name: 'Old FD', due_date: '2026-10-01' }),
    L({ agency_name: 'Unknown County FD', county: null }),
    L({ agency_name: 'Outside FD', county: 'Franklin' }),
    L({ agency_name: 'WV FD', state: 'WV', county: 'Ohio', categories: ['Hose/Nozzles'] }),
  ];
  const run = (over = {}) => filterLeads(leads, { ...DEFAULT_FILTERS, ...over }, set, TODAY).map((l) => l.agency_name);

  it('hides closed and outside-area leads by default and keeps unknown-county ones', () => {
    const names = run();
    expect(names).toContain('Unknown County FD');
    expect(names).not.toContain('Old FD');
    expect(names).not.toContain('Outside FD');
  });
  it('can show closed, outside-only, in-area-only, or everything', () => {
    expect(run({ showClosed: true })).toContain('Old FD');
    expect(run({ area: 'outside' })).toEqual(['Outside FD']);
    expect(run({ area: 'in' })).not.toContain('Unknown County FD');
    expect(run({ area: 'all', showClosed: true })).toHaveLength(7);
  });
  it('filters by state, county, category, status and grant', () => {
    expect(run({ state: 'WV' })).toEqual(['WV FD']);
    expect(run({ county: 'Ohio', state: 'WV' })).toEqual(['WV FD']);
    expect(run({ county: '__unknown' })).toEqual(['Unknown County FD']);
    expect(run({ category: 'SCBA' })).toEqual(['Zeta FD']);
    expect(run({ status: 'Reviewing' })).toEqual(['Alpha FD']);
    expect(run({ grantOnly: true })).toEqual(['Zeta FD']);
  });
  it('searches agency, city, items, brands, NFPA codes and summary', () => {
    expect(run({ search: 'canton' })).toEqual(['Alpha FD']);
    expect(run({ search: 'msa' })).toEqual(['Zeta FD']);
    expect(run({ search: 'nfpa 1981' })).toEqual(['Zeta FD']);
    expect(run({ search: 'bunker' })).toEqual(['Alpha FD']);
    expect(run({ search: 'zzz' })).toEqual([]);
  });
  it('sorts soonest due date first with undated after, and closed last; or by name', () => {
    const open = filterLeads(leads, { ...DEFAULT_FILTERS, showClosed: true }, set, TODAY);
    expect(sortLeads(open, 'due', TODAY).map((l) => l.agency_name).slice(0, 3)).toEqual(['Alpha FD', 'Zeta FD', 'Unknown County FD'].slice(0, 3));
    expect(sortLeads(open, 'due', TODAY).at(-1).agency_name).toBe('Old FD');
    expect(sortLeads(open, 'name', TODAY)[0].agency_name).toBe('Alpha FD');
  });
});

describe('lead helpers', () => {
  it('collects NFPA codes and brands once', () => {
    const l = L({ items: [{ item_name: 'a', nfpa_standards: ['NFPA 1981', 'NFPA 1971'], preferred_brands: ['MSA'] }, { item_name: 'b', nfpa_standards: ['NFPA 1981'], preferred_brands: ['Scott', 'MSA'] }] });
    expect(nfpaOf(l)).toEqual(['NFPA 1981', 'NFPA 1971']);
    expect(brandsOf(l)).toEqual(['MSA', 'Scott']);
    expect(itemSummary(l, 1)).toEqual({ shown: ['a'], more: 1 });
  });
  it('only treats web addresses as links', () => {
    expect(safeUrl('https://a.example')).toBe('https://a.example');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('entering and pasting leads', () => {
  it('parses an array, {leads}, or a single lead, and explains bad input', () => {
    expect(parseLeadsJson('[{"agency_name":"A","state":"OH"}]')).toHaveLength(1);
    expect(parseLeadsJson('{"leads":[{},{}]}')).toHaveLength(2);
    expect(parseLeadsJson('{"agency_name":"A","state":"OH"}')).toHaveLength(1);
    expect(() => parseLeadsJson('nope')).toThrow(/valid JSON/);
    expect(() => parseLeadsJson('{"a":1}')).toThrow(/array of leads/);
  });
  it('turns one item per line into items with optional quantities', () => {
    expect(parseItemLines('SCBA packs x10\nThermal imaging camera, 2\nTurnout coats\n\n')).toEqual([
      { item_name: 'SCBA packs', quantity: 10, preferred_brands: [], nfpa_standards: [] },
      { item_name: 'Thermal imaging camera', quantity: 2, preferred_brands: [], nfpa_standards: [] },
      { item_name: 'Turnout coats', quantity: null, preferred_brands: [], nfpa_standards: [] },
    ]);
  });
  it('builds a lead from the entry form', () => {
    const lead = leadFromForm({ agency_name: ' Test FD ', city: '', county: 'Stark', state: 'OH', solicitation_number: '', due_date: '2026-12-01',
      grant_funded: true, summary: ' s ', items: 'Hose x5', source_url: 'https://x.example', source_name: '' });
    expect(lead).toMatchObject({ agency_name: 'Test FD', city: null, county: 'Stark', solicitation_number: null, grant_funded: true, summary: 's' });
    expect(lead.items).toHaveLength(1);
    expect(lead.sources).toEqual([{ source: 'Entered by hand', url: 'https://x.example' }]);
  });
});
