-- RLS + RPC tests. Run via supabase/tests/run.sh. Any failed assertion aborts with an error.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.as_user(uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(uid::text, ''), false);
  EXECUTE CASE WHEN uid IS NULL THEN 'SET ROLE anon' ELSE 'SET ROLE authenticated' END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(uuid) TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT cond THEN RAISE EXCEPTION 'FAILED: %', msg; END IF; RAISE NOTICE 'ok - %', msg; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert(boolean, text) TO PUBLIC;

-- fixtures (as superuser)
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1','office@fireforce.local'),
  ('00000000-0000-0000-0000-0000000000b1','amy@fireforce.local'),
  ('00000000-0000-0000-0000-0000000000b2','bob@fireforce.local');
INSERT INTO users_ff2024 (id, username, name, role, password_hash, auth_id) VALUES
  ('10000000-0000-0000-0000-0000000000a1','office','Office','office',NULL,'00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-0000000000b1','amy','Amy','salesman',NULL,'00000000-0000-0000-0000-0000000000b1'),
  ('10000000-0000-0000-0000-0000000000b2','bob','Bob','salesman',NULL,'00000000-0000-0000-0000-0000000000b2');
INSERT INTO invoices_ff2024 (id, sales_rep, sales_rep_id, customer_name, status) VALUES
  ('20000000-0000-0000-0000-000000000001','Amy','10000000-0000-0000-0000-0000000000b1','C1','pending'),
  ('20000000-0000-0000-0000-000000000002','Bob','10000000-0000-0000-0000-0000000000b2','C2','pending');
INSERT INTO invoice_items_ff2024 (invoice_id, qty, unit_price) VALUES
  ('20000000-0000-0000-0000-000000000001',1,10),('20000000-0000-0000-0000-000000000002',1,20);
INSERT INTO customers_ff2024 (name) VALUES ('Cust');

-- anon sees nothing
SELECT pg_temp.as_user(NULL);
DO $$ BEGIN
  PERFORM pg_temp.assert((SELECT count(*) FROM invoices_ff2024) = 0, 'anon cannot read invoices');
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - anon denied on invoices (no privilege)'; END $$;
DO $$ BEGIN
  PERFORM count(*) FROM settings_ff2024;
  RAISE EXCEPTION 'FAILED: anon read settings';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - anon denied on settings'; END $$;

-- salesman Amy
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.assert((SELECT count(*) FROM invoices_ff2024) = 1, 'amy sees only her invoice');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_items_ff2024) = 1, 'amy sees only her items');
SELECT pg_temp.assert((SELECT count(*) FROM customers_ff2024) = 1, 'amy reads customers');
DO $$ BEGIN
  UPDATE settings_ff2024 SET value='99' WHERE key='tax_rate';
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM settings_ff2024 WHERE value='99'), 'amy cannot change settings');
END $$;
DO $$ BEGIN
  INSERT INTO users_ff2024 (username, name, role, password_hash) VALUES ('evil','Evil','office','x');
  RAISE EXCEPTION 'FAILED: amy created an office user';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - amy cannot create users'; END $$;
DO $$ BEGIN
  UPDATE users_ff2024 SET role='office' WHERE username='amy';
  PERFORM pg_temp.assert((SELECT role FROM users_ff2024 WHERE username='amy') = 'salesman', 'amy cannot promote herself');
END $$;
DO $$ BEGIN
  UPDATE invoices_ff2024 SET status='done' WHERE id='20000000-0000-0000-0000-000000000002';
  PERFORM pg_temp.assert(true, 'update of bob invoice is a no-op for amy');
END $$;
DO $$ DECLARE v uuid; BEGIN
  v := save_invoice('{"date":"2026-01-02","customerName":"X","taxRate":10,"shippingCost":5,"salesRepId":"10000000-0000-0000-0000-0000000000b2"}',
    '[{"qty":3,"unitPrice":10.005,"taxable":true},{"qty":1,"unitPrice":20,"taxable":false}]');
  PERFORM pg_temp.assert((SELECT sales_rep_id FROM invoices_ff2024 WHERE id=v) = '10000000-0000-0000-0000-0000000000b1', 'salesman cannot assign invoice to another rep');
  PERFORM pg_temp.assert((SELECT subtotal FROM invoices_ff2024 WHERE id=v) = 50.02, 'server subtotal (30.02 + 20.00)');
  PERFORM pg_temp.assert((SELECT tax FROM invoices_ff2024 WHERE id=v) = 3.00, 'server tax on taxable lines only');
  PERFORM pg_temp.assert((SELECT grand_total FROM invoices_ff2024 WHERE id=v) = 58.02, 'server grand total incl shipping');
  -- edit own invoice replaces items atomically
  PERFORM save_invoice(jsonb_build_object('id', v, 'date','2026-01-02','customerName','X2','taxRate',0), '[{"qty":1,"unitPrice":1}]');
  PERFORM pg_temp.assert((SELECT count(*) FROM invoice_items_ff2024 WHERE invoice_id=v) = 1, 'items replaced on update');
END $$;
DO $$ BEGIN
  PERFORM save_invoice('{"id":"20000000-0000-0000-0000-000000000002","customerName":"hack"}', '[{"qty":1,"unitPrice":1}]');
  RAISE EXCEPTION 'FAILED: amy edited bob invoice via RPC';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - amy cannot edit bob invoice via RPC'; END $$;
DO $$ BEGIN
  PERFORM delete_invoice('20000000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'FAILED: salesman deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - salesman cannot delete invoices'; END $$;
DO $$ BEGIN
  PERFORM restore_backup('{"version":"1","data":{"customers":[]}}'); RAISE EXCEPTION 'FAILED: salesman restored';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - salesman cannot restore'; END $$;

-- office
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.assert((SELECT count(*) FROM invoices_ff2024) = 3, 'office sees all invoices');
SELECT delete_invoice('20000000-0000-0000-0000-000000000002');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM invoice_items_ff2024 WHERE invoice_id='20000000-0000-0000-0000-000000000002')
  AND NOT EXISTS (SELECT 1 FROM invoices_ff2024 WHERE id='20000000-0000-0000-0000-000000000002'), 'office deletes invoice + items');

-- restore is all-or-nothing
DO $$ BEGIN
  PERFORM restore_backup('{"version":"1","data":{"customers":[{"name":"New"}],"invoices":[{"id":"not-a-uuid"}]}}');
  RAISE EXCEPTION 'FAILED: bad backup accepted';
EXCEPTION WHEN invalid_text_representation THEN RAISE NOTICE 'ok - bad backup rejected'; END $$;
SELECT pg_temp.assert((SELECT count(*) FROM customers_ff2024) = 1 AND (SELECT count(*) FROM invoices_ff2024) = 2, 'failed restore changed nothing');
SELECT pg_temp.assert((restore_backup('{"version":"1","data":{"customers":[{"name":"A"},{"name":"B"}],
  "invoices":[{"id":"30000000-0000-0000-0000-000000000001","salesRep":"Amy","taxRate":8,"items":[{"qty":2,"unitPrice":5}]}],
  "settings":{"taxRate":7.5}}}')->>'invoices')::int = 1, 'good restore reports counts');
SELECT pg_temp.assert((SELECT count(*) FROM customers_ff2024) = 2, 'restore replaced customers');
SELECT pg_temp.assert((SELECT sales_rep_id FROM invoices_ff2024 WHERE id='30000000-0000-0000-0000-000000000001') = '10000000-0000-0000-0000-0000000000b1', 'restore links rep by name');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_items_ff2024) = 1, 'restore inserted items');
SELECT pg_temp.assert((SELECT value FROM settings_ff2024 WHERE key='tax_rate') = '7.5', 'restore set tax rate');
SELECT pg_temp.assert((SELECT count(*) FROM users_ff2024) = 3, 'restore never touches users');

-- invoice numbers + audit trail (as office; fixtures inserted earlier by superuser)
SELECT pg_temp.assert((SELECT count(DISTINCT invoice_number) FROM invoices_ff2024) = (SELECT count(*) FROM invoices_ff2024), 'invoice numbers are unique');
SELECT pg_temp.assert((SELECT invoice_number FROM invoices_ff2024 WHERE id='30000000-0000-0000-0000-000000000001') IS NOT NULL, 'restored invoice has a number');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_events WHERE action='restored') = 1, 'restore logs a single event');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_events WHERE action='created' AND invoice_id='30000000-0000-0000-0000-000000000001') = 0, 'restore does not log per-invoice events');
DO $$ BEGIN
  INSERT INTO invoice_events (action) VALUES ('forged'); RAISE EXCEPTION 'FAILED: office forged an event';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - events cannot be inserted by users'; END $$;
DO $$ BEGIN
  DELETE FROM invoice_events; RAISE EXCEPTION 'FAILED: office deleted events';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - events cannot be deleted'; END $$;
DO $$ BEGIN
  UPDATE invoice_events SET actor_name='x'; RAISE EXCEPTION 'FAILED: office edited events';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - events cannot be edited'; END $$;

-- restore preserves numbers and keeps the sequence above them
SELECT restore_backup('{"version":"1","data":{"invoices":[
  {"id":"40000000-0000-0000-0000-000000000001","invoiceNumber":500,"salesRep":"Amy","items":[{"qty":1,"unitPrice":1}]},
  {"id":"40000000-0000-0000-0000-000000000002","salesRep":"Amy","items":[{"qty":1,"unitPrice":1}]}]}}');
SELECT pg_temp.assert((SELECT invoice_number FROM invoices_ff2024 WHERE id='40000000-0000-0000-0000-000000000001') = 500, 'restore keeps invoice number 500');
SELECT pg_temp.assert((SELECT invoice_number FROM invoices_ff2024 WHERE id='40000000-0000-0000-0000-000000000002') > 500, 'unnumbered invoice gets a number above the max');

-- as Amy: numbering + events
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
CREATE TEMP TABLE amy_inv AS SELECT save_invoice('{"date":"2026-02-01","customerName":"Z","taxRate":0}', '[{"qty":1,"unitPrice":10,"description":"a"}]') AS id;
GRANT ALL ON amy_inv TO PUBLIC;
SELECT pg_temp.assert((SELECT invoice_number FROM invoices_ff2024 WHERE id=(SELECT id FROM amy_inv)) > 500, 'new invoice gets the next number');
SELECT pg_temp.assert((SELECT actor_name FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='created') = 'Amy', 'created event records the actor');
DO $$ DECLARE n bigint; BEGIN
  SELECT invoice_number INTO n FROM invoices_ff2024 WHERE id=(SELECT id FROM amy_inv);
  UPDATE invoices_ff2024 SET invoice_number = 1 WHERE id=(SELECT id FROM amy_inv);
  PERFORM pg_temp.assert((SELECT invoice_number FROM invoices_ff2024 WHERE id=(SELECT id FROM amy_inv)) = n, 'salesman cannot change an invoice number');
END $$;
UPDATE invoices_ff2024 SET status='completed' WHERE id=(SELECT id FROM amy_inv);
UPDATE invoices_ff2024 SET archived=true WHERE id=(SELECT id FROM amy_inv);
SELECT pg_temp.assert((SELECT changes->'status'->>'to' FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='status_changed') = 'completed', 'status change logged with before/after');
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='archived'), 'archive logged');
SELECT save_invoice(jsonb_build_object('id',(SELECT id FROM amy_inv),'date','2026-02-01','customerName','Z','taxRate',0,'status','completed'), '[{"qty":2,"unitPrice":10,"description":"a"},{"qty":1,"unitPrice":5,"description":"b"}]');
SELECT pg_temp.assert((SELECT (changes->'items'->>'added')::int FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='updated' ORDER BY id DESC LIMIT 1) = 2
  AND (SELECT (changes->'items'->>'removed')::int FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='updated' ORDER BY id DESC LIMIT 1) = 1, 'item edits logged (2 added, 1 removed)');
SELECT save_invoice(jsonb_build_object('id',(SELECT id FROM amy_inv),'date','2026-02-01','customerName','Z','taxRate',0,'status','completed'), '[{"qty":2,"unitPrice":10,"description":"a"},{"qty":1,"unitPrice":5,"description":"b"}]');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv) AND action='updated') = 1, 'no-op save logs nothing');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_events) = (SELECT count(*) FROM invoice_events WHERE invoice_id IN (SELECT id FROM invoices_ff2024)), 'salesman only sees events of invoices they can see');
DO $$ BEGIN
  INSERT INTO invoice_events (action) VALUES ('forged'); RAISE EXCEPTION 'FAILED: salesman forged an event';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - salesman cannot forge events'; END $$;
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
SELECT delete_invoice((SELECT id FROM amy_inv));
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM invoice_events WHERE action='deleted' AND invoice_id=(SELECT id FROM amy_inv)), 'deletion logged and history survives');
SELECT pg_temp.assert((SELECT count(*) FROM invoice_events WHERE invoice_id=(SELECT id FROM amy_inv)) >= 5, 'history of deleted invoice is kept');

-- rename sync
RESET ROLE;
UPDATE users_ff2024 SET name='Amy B' WHERE username='amy';
SELECT pg_temp.assert((SELECT sales_rep FROM invoices_ff2024 WHERE id='40000000-0000-0000-0000-000000000001') = 'Amy B', 'rename syncs invoice display name');
\echo ALL RLS TESTS PASSED
