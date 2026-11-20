// Pure helpers for the FireBid Tracker screen (no React, no network).
export const STATUSES = ['New', 'Reviewing', 'Quoted', 'Passed'];
export const CATEGORIES = ['SCBA', 'Turnout Gear', 'Extrication', 'Thermal Imaging', 'Hose/Nozzles', 'Rescue Gear', 'Apparatus', 'Radios', 'Other'];
export const SERVICE_STATES = ['OH', 'PA', 'WV'];
export const STATE_NAMES = { OH: 'Ohio', PA: 'Pennsylvania', WV: 'West Virginia' };
export const DEFAULT_FEED_URL = '/data/fire_equipment_leads.json';

export const DEFAULT_FILTERS = {
  search: '', state: 'all', county: 'all', category: 'all', status: 'all',
  grantOnly: false, area: 'served', showClosed: false, sort: 'due',
};

// Local calendar date as YYYY-MM-DD (due dates are plain dates, so don't compare them in UTC)
export const todayISO = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export const daysUntil = (due, today) =>
  due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;

export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

export const countySet = (rows = []) => new Set(rows.map((c) => `${c.state}|${String(c.county).toLowerCase()}`));

// 'in' = a county we serve, 'unknown' = no county on the lead yet, 'outside' = anywhere else (mirrors bid_area() in the database)
export const areaOf = (lead, set) => {
  if (!SERVICE_STATES.includes(lead.state)) return 'outside';
  if (!lead.county) return 'unknown';
  return set.has(`${lead.state}|${lead.county.toLowerCase()}`) ? 'in' : 'outside';
};

export const isClosed = (lead, today) => lead.status === 'Passed' || (lead.due_date != null && daysUntil(lead.due_date, today) < 0);

const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// How to show a due date: text plus a tone the UI maps to a color
export function dueInfo(lead, today) {
  if (!lead.due_date) return { label: 'No due date', tone: 'none' };
  const d = daysUntil(lead.due_date, today);
  const date = fmtDate(lead.due_date);
  if (d < 0) return { label: `${date} · closed`, tone: 'closed' };
  if (d === 0) return { label: `${date} · today`, tone: 'urgent' };
  if (d <= 7) return { label: `${date} · ${d} day${d === 1 ? '' : 's'}`, tone: 'urgent' };
  if (d <= 14) return { label: `${date} · ${d} days`, tone: 'soon' };
  return { label: date, tone: 'normal' };
}

export function computeMetrics(leads, today, set) {
  const open = leads.filter((l) => areaOf(l, set) !== 'outside' && !isClosed(l, today));
  return {
    active: open.length,
    due14: open.filter((l) => l.due_date && daysUntil(l.due_date, today) <= 14).length,
    grant: open.filter((l) => l.grant_funded).length,
    inProgress: open.filter((l) => l.status === 'Reviewing' || l.status === 'Quoted').length,
  };
}

export const uniq = (arr) => [...new Set(arr.filter(Boolean))];
export const nfpaOf = (lead) => uniq((lead.items ?? []).flatMap((i) => i.nfpa_standards ?? []));
export const brandsOf = (lead) => uniq((lead.items ?? []).flatMap((i) => i.preferred_brands ?? []));

const searchText = (l) =>
  [l.agency_name, l.city, l.county, l.state, l.solicitation_number, l.summary, ...(l.categories ?? []),
    ...(l.items ?? []).map((i) => i.item_name), ...brandsOf(l), ...nfpaOf(l)]
    .filter(Boolean).join(' ').toLowerCase();

export function filterLeads(leads, f, set, today) {
  const q = f.search.trim().toLowerCase();
  return leads.filter((l) => {
    const area = areaOf(l, set);
    if (f.area === 'served' && area === 'outside') return false;
    if (f.area === 'in' && area !== 'in') return false;
    if (f.area === 'outside' && area !== 'outside') return false;
    if (!f.showClosed && isClosed(l, today)) return false;
    if (f.state !== 'all' && l.state !== f.state) return false;
    if (f.county !== 'all' && (f.county === '__unknown' ? !!l.county : (l.county ?? '').toLowerCase() !== f.county.toLowerCase())) return false;
    if (f.category !== 'all' && !(l.categories ?? []).includes(f.category)) return false;
    if (f.status !== 'all' && l.status !== f.status) return false;
    if (f.grantOnly && !l.grant_funded) return false;
    return !q || searchText(l).includes(q);
  });
}

// Soonest open due date first, then leads without a date, then closed ones; or A-Z by agency
export function sortLeads(leads, sort, today) {
  const rank = (l) => (isClosed(l, today) ? 2 : l.due_date ? 0 : 1);
  const byName = (a, b) => a.agency_name.localeCompare(b.agency_name);
  return [...leads].sort(sort === 'name' ? byName : (a, b) => rank(a) - rank(b) || (a.due_date ?? '').localeCompare(b.due_date ?? '') || byName(a, b));
}

export const itemSummary = (lead, max = 3) => {
  const items = lead.items ?? [];
  const shown = items.slice(0, max).map((i) => `${i.item_name}${i.quantity ? ` ×${i.quantity}` : ''}`);
  return { shown, more: Math.max(0, items.length - max) };
};

// Accepts a JSON array, { leads: [...] } or a single lead object; throws a readable error otherwise
export function parseLeadsJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
  const leads = Array.isArray(data) ? data : Array.isArray(data?.leads) ? data.leads : data && typeof data === 'object' && data.agency_name ? [data] : null;
  if (!leads) throw new Error('Expected a JSON array of leads (or one lead object with an agency_name).');
  return leads;
}

// "SCBA packs x10" or "SCBA packs, 10" per line -> items
export function parseItemLines(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*?)(?:\s*(?:x|×|,|-)\s*(\d+))?$/i);
    const name = (m?.[1] || line).trim();
    return { item_name: name, quantity: m?.[2] ? Number(m[2]) : null, preferred_brands: [], nfpa_standards: [] };
  });
}

export function leadFromForm(f) {
  return {
    agency_name: f.agency_name.trim(), city: f.city.trim() || null, county: f.county.trim() || null, state: f.state,
    solicitation_number: f.solicitation_number.trim() || null, due_date: f.due_date || null, grant_funded: !!f.grant_funded,
    summary: f.summary.trim(), items: parseItemLines(f.items),
    sources: f.source_url.trim() ? [{ source: f.source_name.trim() || 'Entered by hand', url: f.source_url.trim() }] : [],
  };
}
