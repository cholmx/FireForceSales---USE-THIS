/*
# Automatic bid finding

- bid_watch_pages: public township / city / fire-district pages checked every day (office manages the list)
- bid_inbox: alert emails received by the inbound address, queued until the daily run reads them with AI,
  plus a short log of what each one produced (the email body is kept for 30 days)
- bid_ai_usage: how many AI reads happened each day (cost brake)
- bid_settings gets the finder's switches: SAM.gov on/off + keywords + last run, allowed alert senders

Who can do what: any signed-in staff can see the watched pages; only office-level users can change them and see the inbox log.
Anonymous visitors get nothing. The Edge Functions use the service key.
*/

CREATE TABLE IF NOT EXISTS bid_watch_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  url text NOT NULL UNIQUE CHECK (url ~* '^https?://'),
  state text CHECK (state IN ('OH', 'PA', 'WV')),
  county text,
  active boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_hash text,
  last_status text,
  last_found int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bid_inbox (
  id bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  message_id text UNIQUE,
  sender text,
  subject text,
  body text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processed', 'skipped', 'error')),
  leads_found int NOT NULL DEFAULT 0,
  note text,
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS bid_inbox_status_idx ON bid_inbox (status, received_at);

CREATE TABLE IF NOT EXISTS bid_ai_usage (
  day date PRIMARY KEY,
  calls int NOT NULL DEFAULT 0
);

INSERT INTO bid_settings (key, value) VALUES
  ('sam_enabled', 'true'),
  ('sam_keywords', 'SCBA, self-contained breathing, turnout gear, bunker gear, firefighter, fire truck, fire apparatus, pumper, extrication, thermal imaging, fire hose, fire station'),
  ('sam_last_run', ''),
  ('email_senders', ''),
  ('inbound_address', '')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE bid_watch_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bid_watch_pages, bid_inbox, bid_ai_usage FROM anon, authenticated;
REVOKE ALL ON SEQUENCE bid_inbox_id_seq FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON bid_watch_pages TO authenticated;
GRANT SELECT (id, received_at, sender, subject, status, leads_found, note, processed_at) ON bid_inbox TO authenticated;  -- never the body

DROP POLICY IF EXISTS bid_watch_read ON bid_watch_pages;
DROP POLICY IF EXISTS bid_watch_write ON bid_watch_pages;
CREATE POLICY bid_watch_read ON bid_watch_pages FOR SELECT TO authenticated USING (ff_role() IS NOT NULL);
CREATE POLICY bid_watch_write ON bid_watch_pages FOR ALL TO authenticated USING (ff_role() = 'office') WITH CHECK (ff_role() = 'office');

DROP POLICY IF EXISTS bid_inbox_read ON bid_inbox;
CREATE POLICY bid_inbox_read ON bid_inbox FOR SELECT TO authenticated USING (ff_role() = 'office');

-- bid_ai_usage: no policies, service key only
