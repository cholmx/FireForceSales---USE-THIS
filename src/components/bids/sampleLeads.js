// Fictional leads so the board can be tried out. They are flagged as samples in the database, shown with a
// "Sample" badge, and never included in the daily email digest. Remove them from the Add / Import window.
const plus = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const src = (source, slug) => ({ source, url: `https://example.com/sample/${slug}` });

export const buildSampleLeads = () => [
  {
    agency_name: 'Riverside Township Fire Department', city: 'Canton', county: 'Stark', state: 'OH', solicitation_number: 'SAMPLE-2026-014',
    due_date: plus(9), grant_funded: true, summary: 'Replacement SCBA packs and spare cylinders, funded in part by an AFG award.',
    items: [
      { item_name: 'SCBA packs (4500 psi)', quantity: 12, preferred_brands: ['MSA', 'Scott'], nfpa_standards: ['NFPA 1981'] },
      { item_name: 'Spare cylinders', quantity: 24, preferred_brands: [], nfpa_standards: ['NFPA 1981'] },
    ],
    sources: [src('Repository (legal notice)', 'riverside-notice'), src('BidNet Direct', 'riverside-bidnet')],
  },
  {
    agency_name: 'Mahoning Valley Joint Fire District', city: 'Boardman', county: 'Mahoning', state: 'OH', solicitation_number: 'SAMPLE-MV-0307',
    due_date: plus(21), grant_funded: false, summary: 'Structural firefighting turnout gear, coats and pants, with a 10-year service plan.',
    items: [{ item_name: 'Bunker gear (coat and pants)', quantity: 40, preferred_brands: ['Globe', 'Fire-Dex'], nfpa_standards: ['NFPA 1971', 'NFPA 1851'] }],
    sources: [src('District website', 'mvjfd-bids')],
  },
  {
    agency_name: 'Beaver County Emergency Services', city: 'Beaver', county: 'Beaver', state: 'PA', solicitation_number: 'SAMPLE-BC-26-05',
    due_date: plus(5), grant_funded: true, summary: 'Thermal imaging cameras for county fire companies (FEMA AFG).',
    items: [{ item_name: 'Thermal imaging cameras', quantity: 6, preferred_brands: ['Bullard', 'Argus'], nfpa_standards: ['NFPA 1801'] }],
    sources: [src('County bid portal', 'beaver-tic'), src('Beaver County Times notice', 'beaver-times')],
  },
  {
    agency_name: 'Marshall County Volunteer Fire Company', city: 'Moundsville', county: 'Marshall', state: 'WV', solicitation_number: null,
    due_date: plus(30), grant_funded: false, summary: 'Attack hose, supply hose and nozzles for two stations.',
    items: [
      { item_name: '1.75 inch attack hose (50 ft)', quantity: 30, preferred_brands: [], nfpa_standards: ['NFPA 1961'] },
      { item_name: 'Fog nozzles', quantity: 8, preferred_brands: ['Akron', 'Elkhart'], nfpa_standards: ['NFPA 1964'] },
    ],
    sources: [src('Newspaper legal notice', 'marshall-hose')],
  },
  {
    agency_name: 'Erie Regional Fire Authority', city: 'Erie', county: 'Erie', state: 'PA', solicitation_number: 'SAMPLE-ERFA-11',
    due_date: plus(14), grant_funded: false, summary: 'Battery-powered extrication tools for two rescue engines.',
    items: [{ item_name: 'Extrication tool set (spreader, cutter, ram)', quantity: 2, preferred_brands: ['Holmatro', 'Hurst'], nfpa_standards: ['NFPA 1936'] }],
    sources: [src('State e-procurement portal', 'erfa-extrication')],
  },
  {
    agency_name: 'Columbiana Rural Fire District', city: 'Columbiana', county: 'Columbiana', state: 'OH', solicitation_number: null,
    due_date: plus(45), grant_funded: false, summary: 'P25 portable radios and water rescue equipment.',
    items: [
      { item_name: 'P25 portable radios', quantity: 18, preferred_brands: ['Motorola'], nfpa_standards: [] },
      { item_name: 'Water rescue gear (life vests, throw bags)', quantity: 10, preferred_brands: [], nfpa_standards: [] },
    ],
    sources: [src('Township trustees minutes', 'columbiana-radios')],
  },
  {
    agency_name: 'Lakeview Township Fire', city: null, county: null, state: 'OH', solicitation_number: null,
    due_date: null, grant_funded: false, summary: 'Notice mentions a chassis remount; no county or due date was printed.',
    items: [{ item_name: 'Tanker chassis remount', quantity: 1, preferred_brands: [], nfpa_standards: ['NFPA 1901'] }],
    sources: [src('Newspaper legal notice', 'lakeview-remount')],
  },
  {
    agency_name: 'Franklin County Fire Consortium', city: 'Columbus', county: 'Franklin', state: 'OH', solicitation_number: 'SAMPLE-FCFC-9',
    due_date: plus(12), grant_funded: false, summary: 'Outside our service area: shown only when "Outside area" is selected.',
    items: [{ item_name: 'Turnout gear', quantity: 100, preferred_brands: [], nfpa_standards: ['NFPA 1971'] }],
    sources: [src('Consortium site', 'franklin-gear')],
  },
];
