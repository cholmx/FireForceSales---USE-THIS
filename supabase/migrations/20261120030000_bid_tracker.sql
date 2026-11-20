/*
# FireBid Tracker: fire-equipment bid leads

- bid_leads: one row per bid, with every place it was seen merged into `sources`
- bid_counties: the 42 counties we serve (26 Ohio, 11 Pennsylvania, 5 West Virginia); leads are flagged in / outside / unknown
- bid_settings: feed URL and daily-digest switch
- bid_digests: log of daily digest emails (also the "new since last digest" watermark)
- import_bid_leads(): the single place leads are cleaned, de-duplicated and merged. The screen (paste / upload /
  sample / refresh) and the daily Edge Function both call it.

Who can do what: any signed-in staff (Main Admin, Office Admin, Sales) can read leads, add leads through import_bid_leads,
and change a lead's status/notes. Only office-level users can delete leads or change settings. Anonymous users get nothing.
*/

-- ── helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bid_norm_state(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN NULL
    WHEN upper(btrim(p)) IN ('OH', 'OHIO') THEN 'OH'
    WHEN upper(btrim(p)) IN ('PA', 'PENN', 'PENNSYLVANIA') THEN 'PA'
    WHEN upper(btrim(p)) IN ('WV', 'W.V.', 'W VA', 'WVA', 'WEST VIRGINIA') THEN 'WV'
    ELSE upper(btrim(p)) END $$;

CREATE OR REPLACE FUNCTION public.bid_norm_county(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(initcap(btrim(regexp_replace(coalesce(p, ''), '\s+county\s*$', '', 'i'))), '') $$;

CREATE OR REPLACE FUNCTION public.bid_norm_alnum(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g'), '') $$;

-- "Columbiana Fire Department" and "Columbiana Fire Dept." compare equal; "City of Columbiana" stays different
-- (it is a different agency), so a false "not the same" is preferred over wrongly merging two agencies.
CREATE OR REPLACE FUNCTION public.bid_norm_agency(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    NULLIF(btrim(regexp_replace(
      regexp_replace(
        regexp_replace(regexp_replace(lower(coalesce(p, '')), '&', ' and ', 'g'), '[^a-z0-9 ]', ' ', 'g'),
        '\m(fire|department|dept|district|volunteer|vol|company|co|vfd|fd|rescue|ems|association|inc|the|of|and)\M', ' ', 'g'),
      '\s+', ' ', 'g')), ''),
    btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'))) $$;

CREATE OR REPLACE FUNCTION public.bid_categories(p_items jsonb, p_summary text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text := lower(coalesce(p_summary, '') || ' ' ||
    CASE WHEN jsonb_typeof(p_items) = 'array'
         THEN coalesce((SELECT string_agg(coalesce(i->>'item_name', ''), ' ') FROM jsonb_array_elements(p_items) i), '') ELSE '' END);
  cats text[] := '{}';
BEGIN
  IF t ~ '(\mscba|self[- ]contained|breathing apparatus|air pack)' THEN cats := array_append(cats, 'SCBA'); END IF;
  IF t ~ '(turnout|bunker|\mppe\M|protective (clothing|gear|equipment)|structural (coat|pants|helmet|boots|gloves)|fire helmet|firefighting boots|fire gloves)' THEN cats := array_append(cats, 'Turnout Gear'); END IF;
  IF t ~ '(extrication|jaws of life|spreader|hydraulic (cutter|ram|rescue)|rescue tool|combi tool)' THEN cats := array_append(cats, 'Extrication'); END IF;
  IF t ~ '(thermal imag|thermal camera|\mtic\M)' THEN cats := array_append(cats, 'Thermal Imaging'); END IF;
  IF t ~ '(\mhose|nozzle)' THEN cats := array_append(cats, 'Hose/Nozzles'); END IF;
  IF t ~ '(rope rescue|rescue gear|rescue equipment|water rescue|life vest|\mpfd\M|rescue (rope|harness|sled))' THEN cats := array_append(cats, 'Rescue Gear'); END IF;
  IF t ~ '(apparatus|pumper|tanker|tender|aerial|quint|rescue truck|brush truck|\mengine\M|chassis|ambulance|remount|fire truck)' THEN cats := array_append(cats, 'Apparatus'); END IF;
  IF t ~ '(\mradio|\mp25|\mpager)' THEN cats := array_append(cats, 'Radios'); END IF;
  IF cardinality(cats) = 0 THEN cats := ARRAY['Other']; END IF;
  RETURN cats;
END $$;

-- ── tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bid_counties (
  state text NOT NULL,
  county text NOT NULL,
  PRIMARY KEY (state, county)
);
INSERT INTO bid_counties (state, county)
SELECT 'OH', c FROM unnest(ARRAY['Ashtabula','Belmont','Carroll','Columbiana','Coshocton','Cuyahoga','Geauga','Guernsey','Harrison','Holmes',
  'Jefferson','Lake','Lorain','Mahoning','Medina','Monroe','Morgan','Muskingum','Noble','Portage','Stark','Summit','Trumbull',
  'Tuscarawas','Washington','Wayne']) c
UNION ALL
SELECT 'PA', c FROM unnest(ARRAY['Allegheny','Armstrong','Beaver','Butler','Crawford','Erie','Greene','Lawrence','Mercer','Venango','Washington']) c
UNION ALL
SELECT 'WV', c FROM unnest(ARRAY['Brooke','Hancock','Marshall','Ohio','Wetzel']) c
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.bid_area(p_state text, p_county text) RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_state IS NULL OR p_state NOT IN ('OH', 'PA', 'WV') THEN 'outside'
    WHEN p_county IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM bid_counties c WHERE c.state = p_state AND lower(c.county) = lower(p_county)) THEN 'in'
    ELSE 'outside' END $$;

CREATE TABLE IF NOT EXISTS bid_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_name text NOT NULL,
  city text,
  county text,
  state text NOT NULL,
  solicitation_number text,
  due_date date,
  grant_funded boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Reviewing', 'Quoted', 'Passed')),
  summary text NOT NULL DEFAULT '',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  is_sample boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_leads_due_idx ON bid_leads (due_date);
CREATE INDEX IF NOT EXISTS bid_leads_state_idx ON bid_leads (state);
CREATE INDEX IF NOT EXISTS bid_leads_first_seen_idx ON bid_leads (first_seen_at);

CREATE TABLE IF NOT EXISTS bid_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT ''
);
INSERT INTO bid_settings (key, value) VALUES ('feed_url', '/data/fire_equipment_leads.json'), ('digest_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS bid_digests (
  id bigserial PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  leads int NOT NULL DEFAULT 0,
  recipients int NOT NULL DEFAULT 0,
  triggered_by text NOT NULL DEFAULT 'schedule'
);

CREATE OR REPLACE FUNCTION public.bid_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS bid_touch ON bid_leads;
CREATE TRIGGER bid_touch BEFORE UPDATE ON bid_leads FOR EACH ROW EXECUTE FUNCTION public.bid_touch();

-- ── security ────────────────────────────────────────────────────────────────
ALTER TABLE bid_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_counties ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bid_leads, bid_counties, bid_settings, bid_digests FROM anon, authenticated;
REVOKE ALL ON SEQUENCE bid_digests_id_seq FROM anon, authenticated;

GRANT SELECT, DELETE ON bid_leads TO authenticated;
GRANT UPDATE (status, notes) ON bid_leads TO authenticated;          -- staff can only change status and notes directly
GRANT SELECT ON bid_counties, bid_digests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bid_settings TO authenticated;

DROP POLICY IF EXISTS bid_leads_read ON bid_leads;
DROP POLICY IF EXISTS bid_leads_update ON bid_leads;
DROP POLICY IF EXISTS bid_leads_delete ON bid_leads;
CREATE POLICY bid_leads_read ON bid_leads FOR SELECT TO authenticated USING (ff_role() IS NOT NULL);
CREATE POLICY bid_leads_update ON bid_leads FOR UPDATE TO authenticated USING (ff_role() IS NOT NULL) WITH CHECK (ff_role() IS NOT NULL);
CREATE POLICY bid_leads_delete ON bid_leads FOR DELETE TO authenticated USING (ff_role() = 'office');

DROP POLICY IF EXISTS bid_counties_read ON bid_counties;
CREATE POLICY bid_counties_read ON bid_counties FOR SELECT TO authenticated USING (ff_role() IS NOT NULL);

DROP POLICY IF EXISTS bid_settings_read ON bid_settings;
DROP POLICY IF EXISTS bid_settings_write ON bid_settings;
CREATE POLICY bid_settings_read ON bid_settings FOR SELECT TO authenticated USING (ff_role() IS NOT NULL);
CREATE POLICY bid_settings_write ON bid_settings FOR ALL TO authenticated USING (ff_role() = 'office') WITH CHECK (ff_role() = 'office');

DROP POLICY IF EXISTS bid_digests_read ON bid_digests;
CREATE POLICY bid_digests_read ON bid_digests FOR SELECT TO authenticated USING (ff_role() = 'office');

-- ── import + de-duplication ─────────────────────────────────────────────────
-- A lead matches an existing one in the same state when:
--   (a) the solicitation numbers are equal (ignoring case and punctuation), or
--   (b) the agency names match after normalising AND the due dates are within 3 days (or one is unknown)
--       AND the equipment categories overlap (or one has none).
-- A match is merged (sources, items, missing fields); status and notes are never touched. Otherwise a new lead is added.
CREATE OR REPLACE FUNCTION public.import_bid_leads(p_leads jsonb, p_mark_sample boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e jsonb; idx int := 0;
  v_ins int := 0; v_merged int := 0; v_skipped int := 0; v_errors jsonb := '[]'::jsonb;
  v_agency text; v_state text; v_county text; v_city text; v_sol text; v_due date; v_summary text;
  v_items jsonb; v_sources jsonb; v_cats text[]; v_grant boolean; v_id uuid;
BEGIN
  -- Written without NOT(...) on purpose: auth.role() is NULL for a signed-in user, and NOT(NULL) would let them through.
  IF coalesce(auth.role(), '') <> 'service_role' AND ff_role() IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_leads) <> 'array' THEN RAISE EXCEPTION 'Expected a JSON array of leads'; END IF;
  IF jsonb_array_length(p_leads) > 500 THEN RAISE EXCEPTION 'Import at most 500 leads at a time'; END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(p_leads) LOOP
    idx := idx + 1;
    BEGIN
      v_agency := left(NULLIF(btrim(e->>'agency_name'), ''), 200);
      v_state := bid_norm_state(e->>'state');
      IF v_agency IS NULL OR v_state IS NULL THEN
        v_skipped := v_skipped + 1;
        v_errors := v_errors || jsonb_build_object('index', idx, 'error', 'agency_name and state are required');
        CONTINUE;
      END IF;
      v_county := bid_norm_county(e->>'county');
      v_city := left(NULLIF(btrim(e->>'city'), ''), 120);
      v_sol := left(NULLIF(btrim(e->>'solicitation_number'), ''), 120);
      v_due := NULLIF(e->>'due_date', '')::date;
      v_summary := left(coalesce(e->>'summary', ''), 4000);
      v_grant := coalesce((e->>'grant_funded')::boolean, false);
      v_items := CASE WHEN jsonb_typeof(e->'items') = 'array' THEN e->'items' ELSE '[]'::jsonb END;
      -- only web links are kept (no javascript: or data: URLs)
      v_sources := coalesce((SELECT jsonb_agg(s) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e->'sources') = 'array' THEN e->'sources' ELSE '[]'::jsonb END) s
                             WHERE s->>'url' ~* '^https?://'), '[]'::jsonb);
      v_cats := bid_categories(v_items, v_summary);

      SELECT l.id INTO v_id FROM bid_leads l
      WHERE l.state = v_state AND (
        (v_sol IS NOT NULL AND bid_norm_alnum(l.solicitation_number) = bid_norm_alnum(v_sol))
        OR (bid_norm_agency(l.agency_name) = bid_norm_agency(v_agency)
            AND (l.due_date IS NULL OR v_due IS NULL OR abs(l.due_date - v_due) <= 3)
            AND (l.categories && v_cats OR cardinality(l.categories) = 0 OR cardinality(v_cats) = 0))
      )
      ORDER BY (v_sol IS NOT NULL AND bid_norm_alnum(l.solicitation_number) = bid_norm_alnum(v_sol)) DESC, l.first_seen_at
      LIMIT 1;

      IF v_id IS NOT NULL THEN
        UPDATE bid_leads l SET
          city = coalesce(l.city, v_city),
          county = coalesce(l.county, v_county),
          solicitation_number = coalesce(l.solicitation_number, v_sol),
          due_date = coalesce(l.due_date, v_due),
          grant_funded = l.grant_funded OR v_grant,
          summary = CASE WHEN length(v_summary) > length(l.summary) THEN v_summary ELSE l.summary END,
          items = (SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord), '[]'::jsonb) FROM (
                     SELECT DISTINCT ON (lower(coalesce(u.j->>'item_name', u.j::text))) u.j, u.ord FROM (
                       SELECT j, 1 AS ord FROM jsonb_array_elements(l.items) j
                       UNION ALL SELECT j, 2 FROM jsonb_array_elements(v_items) j) u
                     ORDER BY lower(coalesce(u.j->>'item_name', u.j::text)), u.ord) x),
          sources = (SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord), '[]'::jsonb) FROM (
                     SELECT DISTINCT ON (lower(coalesce(u.j->>'url', u.j::text))) u.j, u.ord FROM (
                       SELECT j, 1 AS ord FROM jsonb_array_elements(l.sources) j
                       UNION ALL SELECT j, 2 FROM jsonb_array_elements(v_sources) j) u
                     ORDER BY lower(coalesce(u.j->>'url', u.j::text)), u.ord) x),
          categories = (SELECT array_agg(DISTINCT c) FROM unnest(l.categories || v_cats) c WHERE c <> 'Other' OR cardinality(l.categories || v_cats) = 1),
          last_seen_at = now()
        WHERE l.id = v_id;
        v_merged := v_merged + 1;
      ELSE
        INSERT INTO bid_leads (agency_name, city, county, state, solicitation_number, due_date, grant_funded, summary,
                               items, sources, categories, is_sample)
        VALUES (v_agency, v_city, v_county, v_state, v_sol, v_due, v_grant, v_summary, v_items, v_sources, v_cats, p_mark_sample);
        v_ins := v_ins + 1;
      END IF;
    EXCEPTION WHEN others THEN
      v_skipped := v_skipped + 1;
      v_errors := v_errors || jsonb_build_object('index', idx, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_ins, 'merged', v_merged, 'skipped', v_skipped, 'errors', v_errors);
END $$;

REVOKE ALL ON FUNCTION public.import_bid_leads(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bid_leads(jsonb, boolean) TO authenticated, service_role;
