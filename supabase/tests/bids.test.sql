-- FireBid Tracker tests. Runs after rls.test.sql in the same database (reuses its users:
-- amy = Sales, office = Office Admin, owner = Main Admin).
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.as_user(uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(uid::text, ''), false);
  PERFORM set_config('request.jwt.claim.role', '', false);
  EXECUTE CASE WHEN uid IS NULL THEN 'SET ROLE anon' ELSE 'SET ROLE authenticated' END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(uuid) TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', msg; END IF; RAISE NOTICE 'ok - %', msg; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert(boolean, text) TO PUBLIC;

RESET ROLE;
-- ── reference data and helpers ──────────────────────────────────────────────
SELECT pg_temp.assert((SELECT count(*) FROM bid_counties) = 42, 'service area has 42 counties');
SELECT pg_temp.assert((SELECT count(*) FROM bid_counties WHERE state='OH') = 26 AND (SELECT count(*) FROM bid_counties WHERE state='PA') = 11
  AND (SELECT count(*) FROM bid_counties WHERE state='WV') = 5, 'counties split 26 OH / 11 PA / 5 WV');
SELECT pg_temp.assert(bid_norm_state('Ohio') = 'OH' AND bid_norm_state(' pennsylvania ') = 'PA' AND bid_norm_state('West Virginia') = 'WV', 'state names normalise');
SELECT pg_temp.assert(bid_norm_county('columbiana COUNTY') = 'Columbiana', 'county names normalise');
SELECT pg_temp.assert(bid_norm_agency('Columbiana Fire Department') = bid_norm_agency('COLUMBIANA FIRE DEPT.'), 'agency names match across wording');
SELECT pg_temp.assert(bid_norm_agency('City of Columbiana') <> bid_norm_agency('Columbiana Fire Department'), 'a city and its fire department stay distinct');
SELECT pg_temp.assert(bid_area('OH','Stark') = 'in' AND bid_area('WV','Ohio') = 'in' AND bid_area('OH','Franklin') = 'outside'
  AND bid_area('OH', NULL) = 'unknown' AND bid_area('MI','Wayne') = 'outside' AND bid_area('PA','Wayne') = 'outside', 'service-area flags');
SELECT pg_temp.assert(bid_categories('[{"item_name":"SCBA packs"},{"item_name":"Bunker gear coats"}]', '') @> ARRAY['SCBA','Turnout Gear'], 'categories from item names');
SELECT pg_temp.assert(bid_categories('[]', 'Thermal imaging cameras (TIC) and fire hose') @> ARRAY['Thermal Imaging','Hose/Nozzles'], 'categories from the summary');
SELECT pg_temp.assert(bid_categories('[]', 'Lawn mowers') = ARRAY['Other'], 'unknown equipment falls under Other');

-- ── import as Sales (any signed-in staff may add leads) ─────────────────────
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
CREATE TEMP TABLE r1 AS SELECT import_bid_leads('[
  {"agency_name":"Columbiana Fire Department","city":"Columbiana","county":"Columbiana County","state":"Ohio","solicitation_number":"FD-2026-07",
   "due_date":"2026-12-10","grant_funded":true,"summary":"SCBA replacement",
   "items":[{"item_name":"SCBA packs","quantity":10,"preferred_brands":["MSA"],"nfpa_standards":["NFPA 1981"]}],
   "sources":[{"source":"Morning Journal","url":"https://news.example/1"},{"source":"bad","url":"javascript:alert(1)"}]}
]') AS j;
GRANT SELECT ON r1 TO PUBLIC;
SELECT pg_temp.assert((SELECT (j->>'inserted')::int FROM r1) = 1, 'sales user can import a lead');
SELECT pg_temp.assert((SELECT state || '/' || county || '/' || status FROM bid_leads LIMIT 1) = 'OH/Columbiana/New', 'lead is cleaned and starts as New');
SELECT pg_temp.assert((SELECT jsonb_array_length(sources) FROM bid_leads LIMIT 1) = 1, 'non-web source links are dropped');
SELECT pg_temp.assert((SELECT categories @> ARRAY['SCBA'] FROM bid_leads LIMIT 1), 'category derived on import');

-- same bid seen elsewhere (different number formatting, new source, new item) merges into one lead
SELECT pg_temp.assert((import_bid_leads('[
  {"agency_name":"Columbiana Fire Dept.","state":"OH","solicitation_number":"fd 2026 07","city":"IGNORED",
   "items":[{"item_name":"SCBA packs"},{"item_name":"Spare cylinders","quantity":20}],
   "sources":[{"source":"BidNet","url":"https://bidnet.example/9"}]}]')->>'merged')::int = 1, 'same solicitation number merges');
SELECT pg_temp.assert((SELECT count(*) FROM bid_leads) = 1, 'still one lead after merge');
SELECT pg_temp.assert((SELECT jsonb_array_length(sources) FROM bid_leads) = 2 AND (SELECT jsonb_array_length(items) FROM bid_leads) = 2, 'merge keeps every source and unions items');
SELECT pg_temp.assert((SELECT city FROM bid_leads) = 'Columbiana', 'merge never overwrites known fields');

-- status and notes survive a re-import
UPDATE bid_leads SET status = 'Reviewing', notes = 'Called the chief';
SELECT import_bid_leads('[{"agency_name":"Columbiana Fire Department","state":"OH","solicitation_number":"FD-2026-07","sources":[{"url":"https://x.example/2"}]}]');
SELECT pg_temp.assert((SELECT status || '|' || notes FROM bid_leads) = 'Reviewing|Called the chief', 're-import keeps status and notes');

-- agency + date within 3 days + overlapping category merges; far-apart dates, other states, other equipment do not
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Columbiana Fire Dept","state":"OH","due_date":"2026-12-12","items":[{"item_name":"SCBA cylinders"}]}]')->>'merged')::int = 1, 'same agency, due date within 3 days merges');
SELECT pg_temp.assert((SELECT due_date FROM bid_leads) = '2026-12-10', 'existing due date is kept');
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Columbiana Fire Dept","state":"OH","due_date":"2027-02-01","items":[{"item_name":"SCBA cylinders"}]}]')->>'inserted')::int = 1, 'same agency but a different due date is a new bid');
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Columbiana Fire Dept","state":"PA","due_date":"2026-12-10","items":[{"item_name":"SCBA"}]}]')->>'inserted')::int = 1, 'same name in another state is a new bid');
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Columbiana Fire Dept","state":"OH","due_date":"2026-12-11","items":[{"item_name":"Fire hose"}]}]')->>'inserted')::int = 1, 'different equipment is a new bid');

-- bad rows are reported and skipped without sinking the batch
CREATE TEMP TABLE r2 AS SELECT import_bid_leads('[
  {"agency_name":"No State Dept"},
  {"agency_name":"Bad Date FD","state":"OH","due_date":"not-a-date"},
  {"agency_name":"Good Township FD","state":"OH","county":"Stark","items":[{"item_name":"Turnout gear"}]}]') AS j;
GRANT SELECT ON r2 TO PUBLIC;
SELECT pg_temp.assert((SELECT (j->>'skipped')::int = 2 AND (j->>'inserted')::int = 1 AND jsonb_array_length(j->'errors') = 2 FROM r2), 'bad rows are skipped and reported, good ones still import');
DO $$ BEGIN
  PERFORM import_bid_leads('{"not":"an array"}'); RAISE EXCEPTION 'FAILED: non-array accepted';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'ok - a non-array payload is rejected'; END $$;

-- ── what Sales can and cannot do directly ───────────────────────────────────
SELECT pg_temp.assert((SELECT count(*) FROM bid_leads) > 0, 'sales user can read leads');
UPDATE bid_leads SET status = 'Quoted', notes = 'sent quote' WHERE agency_name = 'Good Township FD';
SELECT pg_temp.assert((SELECT status FROM bid_leads WHERE agency_name = 'Good Township FD') = 'Quoted', 'sales user can change status and notes');
DO $$ BEGIN
  UPDATE bid_leads SET agency_name = 'Hacked'; RAISE EXCEPTION 'FAILED: sales edited lead fields';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - sales cannot edit other lead fields directly'; END $$;
DO $$ BEGIN
  UPDATE bid_leads SET status = 'Bogus'; RAISE EXCEPTION 'FAILED: bad status accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - only valid statuses are accepted'; END $$;
DELETE FROM bid_leads;
SELECT pg_temp.assert((SELECT count(*) FROM bid_leads) > 0, 'sales cannot delete leads');
DO $$ BEGIN
  INSERT INTO bid_leads (agency_name, state) VALUES ('Direct','OH'); RAISE EXCEPTION 'FAILED: direct insert allowed';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - leads can only be added through the import function'; END $$;
UPDATE bid_settings SET value = 'https://evil.example/feed.json' WHERE key = 'feed_url';
SELECT pg_temp.assert((SELECT value FROM bid_settings WHERE key = 'feed_url') = '/data/fire_equipment_leads.json', 'sales cannot change feed settings');
SELECT pg_temp.assert((SELECT count(*) FROM bid_settings) = 2, 'sales can read settings');
SELECT pg_temp.assert((SELECT count(*) FROM bid_digests) = 0, 'sales cannot see the digest log');

-- ── Office Admin / Main Admin ───────────────────────────────────────────────
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
UPDATE bid_settings SET value = 'https://feeds.example/leads.json' WHERE key = 'feed_url';
SELECT pg_temp.assert((SELECT value FROM bid_settings WHERE key = 'feed_url') = 'https://feeds.example/leads.json', 'office admin can change feed settings');
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Sample Twp FD","state":"OH","items":[{"item_name":"Hose"}]}]', true)->>'inserted')::int = 1, 'sample leads can be imported');
SELECT pg_temp.assert((SELECT is_sample FROM bid_leads WHERE agency_name = 'Sample Twp FD'), 'sample leads are flagged');
DELETE FROM bid_leads WHERE is_sample;
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM bid_leads WHERE is_sample), 'office admin can remove sample data');

-- ── not signed in / signed in without a staff profile / the service key ─────
RESET ROLE;
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000d1', 'stranger@example.com');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
DO $$ BEGIN
  PERFORM import_bid_leads('[{"agency_name":"X","state":"OH"}]'); RAISE EXCEPTION 'FAILED: non-staff imported';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a signed-in non-staff account cannot import'; END $$;
SELECT pg_temp.assert((SELECT count(*) FROM bid_leads) = 0, 'a signed-in non-staff account sees no leads');
SELECT pg_temp.as_user(NULL);
DO $$ BEGIN
  PERFORM count(*) FROM bid_leads; RAISE EXCEPTION 'FAILED: anon read leads';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - anonymous visitors cannot read leads'; END $$;
DO $$ BEGIN
  PERFORM import_bid_leads('[]'); RAISE EXCEPTION 'FAILED: anon imported';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - anonymous visitors cannot import'; END $$;

RESET ROLE;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_temp.assert((import_bid_leads('[{"agency_name":"Feed FD","state":"PA","county":"Erie","items":[{"item_name":"SCBA"}]}]')->>'inserted')::int = 1, 'the service key (daily function) can import');
RESET ROLE;
SELECT set_config('request.jwt.claim.role', '', false);
\echo BID TRACKER TESTS PASSED
