/*
# Invoice numbers + audit trail

1. invoices_ff2024.invoice_number: human-friendly sequential number (shown as FF-000123).
   Assigned by the database; salesmen cannot choose or change it. Existing invoices are
   numbered oldest-first.
2. invoice_events: append-only history of who did what to each invoice (created, updated
   with before/after values, status changes, archive/unarchive, deleted, backup restores).
   Written only by triggers; nobody (not even office) can edit or delete rows.
   Office sees everything; a salesman sees events for invoices they can see.
*/

-- ── Invoice numbers ─────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
ALTER TABLE invoices_ff2024 ADD COLUMN IF NOT EXISTS invoice_number bigint;

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
  FROM invoices_ff2024 WHERE invoice_number IS NULL
)
UPDATE invoices_ff2024 i SET invoice_number = (SELECT COALESCE(max(invoice_number), 0) FROM invoices_ff2024) + numbered.n
FROM numbered WHERE i.id = numbered.id;

SELECT setval('invoice_number_seq', GREATEST((SELECT COALESCE(max(invoice_number), 0) FROM invoices_ff2024), 1),
              (SELECT count(*) > 0 FROM invoices_ff2024));

ALTER TABLE invoices_ff2024 ALTER COLUMN invoice_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_number_key ON invoices_ff2024(invoice_number);

CREATE OR REPLACE FUNCTION public.ff_assign_invoice_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only office (backup restore) or the service role may supply a number
    IF NEW.invoice_number IS NULL OR (auth.uid() IS NOT NULL AND ff_role() IS DISTINCT FROM 'office') THEN
      NEW.invoice_number := nextval('invoice_number_seq');
    END IF;
  ELSIF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    NEW.invoice_number := OLD.invoice_number;  -- numbers never change
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ff_assign_invoice_number ON invoices_ff2024;
CREATE TRIGGER ff_assign_invoice_number BEFORE INSERT OR UPDATE ON invoices_ff2024
  FOR EACH ROW EXECUTE FUNCTION public.ff_assign_invoice_number();

-- ── Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid,            -- no FK: history must outlive deleted invoices
  invoice_number bigint,
  action text NOT NULL,
  actor_id uuid,
  actor_name text NOT NULL DEFAULT 'system',
  changes jsonb
);
CREATE INDEX IF NOT EXISTS invoice_events_invoice_idx ON invoice_events(invoice_id, at DESC);
CREATE INDEX IF NOT EXISTS invoice_events_at_idx ON invoice_events(at DESC);

ALTER TABLE invoice_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON invoice_events FROM anon, authenticated;
GRANT SELECT ON invoice_events TO authenticated;      -- read-only for everyone signed in (RLS narrows it)
DROP POLICY IF EXISTS events_read ON invoice_events;
CREATE POLICY events_read ON invoice_events FOR SELECT TO authenticated
  USING (ff_role() = 'office'
         OR (ff_role() = 'salesman' AND EXISTS (SELECT 1 FROM invoices_ff2024 i WHERE i.id = invoice_events.invoice_id)));

CREATE OR REPLACE FUNCTION public.ff_audit_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_changes jsonb; v_items jsonb; v_action text; v_keys int;
  v_actor uuid := ff_user_id();
  v_name text := COALESCE(ff_name(), 'system');
BEGIN
  IF current_setting('ff.suppress_audit', true) = 'on' THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO invoice_events (invoice_id, invoice_number, action, actor_id, actor_name, changes)
    VALUES (NEW.id, NEW.invoice_number, 'created', v_actor, v_name,
            jsonb_build_object('customer_name', NEW.customer_name, 'grand_total', NEW.grand_total, 'status', NEW.status));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO invoice_events (invoice_id, invoice_number, action, actor_id, actor_name, changes)
    VALUES (OLD.id, OLD.invoice_number, 'deleted', v_actor, v_name,
            jsonb_build_object('customer_name', OLD.customer_name, 'grand_total', OLD.grand_total, 'status', OLD.status));
  ELSE
    v_old := to_jsonb(OLD) - 'updated_at';
    v_new := to_jsonb(NEW) - 'updated_at';
    SELECT jsonb_object_agg(key, jsonb_build_object('from', v_old->key, 'to', value))
      INTO v_changes FROM jsonb_each(v_new) WHERE v_old->key IS DISTINCT FROM value;
    v_items := NULLIF(current_setting('ff.items_diff', true), '')::jsonb;
    IF v_items IS NOT NULL THEN v_changes := COALESCE(v_changes, '{}'::jsonb) || jsonb_build_object('items', v_items); END IF;
    IF v_changes IS NULL THEN RETURN NULL; END IF;       -- nothing meaningful changed

    SELECT count(*) INTO v_keys FROM jsonb_object_keys(v_changes);
    v_action := CASE
      WHEN v_keys = 1 AND v_changes ? 'status' THEN 'status_changed'
      WHEN v_keys = 1 AND v_changes ? 'archived' THEN CASE WHEN NEW.archived THEN 'archived' ELSE 'unarchived' END
      ELSE 'updated' END;
    INSERT INTO invoice_events (invoice_id, invoice_number, action, actor_id, actor_name, changes)
    VALUES (NEW.id, NEW.invoice_number, v_action, v_actor, v_name, v_changes);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ff_audit_invoice ON invoices_ff2024;
CREATE TRIGGER ff_audit_invoice AFTER INSERT OR UPDATE OR DELETE ON invoices_ff2024
  FOR EACH ROW EXECUTE FUNCTION public.ff_audit_invoice();

-- ── save_invoice: also records which line items were added/removed ─────────
CREATE OR REPLACE FUNCTION public.save_invoice(p_invoice jsonb, p_items jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_role text := ff_role();
  v_me uuid := ff_user_id();
  v_rep_id uuid;
  v_rep_name text;
  v_rate numeric := COALESCE(NULLIF(p_invoice->>'taxRate', '')::numeric, 0);
  v_ship numeric := COALESCE(NULLIF(p_invoice->>'shippingCost', '')::numeric, 0);
  v_added int; v_removed int;
  t record;
BEGIN
  IF v_role IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line item';
  END IF;
  SELECT * INTO t FROM ff_totals(p_items, v_rate, v_ship);

  IF v_role = 'salesman' THEN
    v_rep_id := v_me;
  ELSE
    v_rep_id := COALESCE(NULLIF(p_invoice->>'salesRepId', '')::uuid,
                         (SELECT sales_rep_id FROM invoices_ff2024 WHERE id = v_id), v_me);
  END IF;
  SELECT name INTO v_rep_name FROM users_ff2024 WHERE id = v_rep_id;

  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO invoices_ff2024 (id, date, po_number, sales_rep, sales_rep_id, transaction_type,
      customer_name, company, customer_email, customer_phone, accounts_payable_email,
      bill_to_address, ship_to_address, shipping_cost, additional_info, status,
      tax_rate, subtotal, tax, grand_total, archived)
    VALUES (v_id, (p_invoice->>'date')::date, p_invoice->>'poNumber', v_rep_name, v_rep_id,
      p_invoice->>'transactionType', p_invoice->>'customerName', p_invoice->>'company',
      p_invoice->>'customerEmail', p_invoice->>'customerPhone', p_invoice->>'accountsPayableEmail',
      p_invoice->>'billToAddress', p_invoice->>'shipToAddress', v_ship, p_invoice->>'additionalInfo',
      COALESCE(NULLIF(p_invoice->>'status', ''), 'pending'),
      v_rate, t.subtotal, t.tax, t.grand_total, false);
  ELSE
    -- Compare old vs new line items (as multisets) so the audit trail can say what changed
    WITH old_items AS (
      SELECT jsonb_build_object('mfg', mfg, 'partNumber', part_number, 'description', description,
             'qty', qty, 'unitPrice', unit_price, 'taxable', taxable) AS j
      FROM invoice_items_ff2024 WHERE invoice_id = v_id),
    new_items AS (
      SELECT jsonb_build_object('mfg', i->>'mfg', 'partNumber', i->>'partNumber', 'description', i->>'description',
             'qty', (i->>'qty')::numeric, 'unitPrice', (i->>'unitPrice')::numeric,
             'taxable', COALESCE((i->>'taxable')::boolean, true)) AS j
      FROM jsonb_array_elements(p_items) i)
    SELECT (SELECT count(*) FROM (SELECT j FROM new_items EXCEPT ALL SELECT j FROM old_items) a),
           (SELECT count(*) FROM (SELECT j FROM old_items EXCEPT ALL SELECT j FROM new_items) r)
      INTO v_added, v_removed;
    IF v_added > 0 OR v_removed > 0 THEN
      PERFORM set_config('ff.items_diff', jsonb_build_object('added', v_added, 'removed', v_removed)::text, true);
    END IF;

    UPDATE invoices_ff2024 SET
      date = (p_invoice->>'date')::date, po_number = p_invoice->>'poNumber',
      sales_rep = COALESCE(v_rep_name, sales_rep), sales_rep_id = COALESCE(v_rep_id, sales_rep_id),
      transaction_type = p_invoice->>'transactionType', customer_name = p_invoice->>'customerName',
      company = p_invoice->>'company', customer_email = p_invoice->>'customerEmail',
      customer_phone = p_invoice->>'customerPhone', accounts_payable_email = p_invoice->>'accountsPayableEmail',
      bill_to_address = p_invoice->>'billToAddress', ship_to_address = p_invoice->>'shipToAddress',
      shipping_cost = v_ship, additional_info = p_invoice->>'additionalInfo',
      status = COALESCE(NULLIF(p_invoice->>'status', ''), status),
      tax_rate = v_rate, subtotal = t.subtotal, tax = t.tax, grand_total = t.grand_total,
      updated_at = now()
    WHERE id = v_id;
    PERFORM set_config('ff.items_diff', '', true);
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found or not allowed' USING ERRCODE = '42501'; END IF;
    DELETE FROM invoice_items_ff2024 WHERE invoice_id = v_id;
  END IF;

  INSERT INTO invoice_items_ff2024 (invoice_id, mfg, part_number, description, qty, unit_price, taxable)
  SELECT v_id, i->>'mfg', i->>'partNumber', i->>'description',
         (i->>'qty')::numeric, (i->>'unitPrice')::numeric, COALESCE((i->>'taxable')::boolean, true)
  FROM jsonb_array_elements(p_items) i;

  RETURN v_id;
END $$;

-- ── restore_backup: keeps invoice numbers, logs ONE event instead of thousands ─
-- SECURITY DEFINER (with an explicit office check) because it writes the audit event
-- and resets the number sequence, which callers have no direct privilege for.
CREATE OR REPLACE FUNCTION public.restore_backup(p_backup jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d jsonb := p_backup->'data';
  n_cust int := 0; n_inv int := 0; n_items int := 0; v_max bigint;
BEGIN
  IF ff_role() IS DISTINCT FROM 'office' THEN RAISE EXCEPTION 'Only office can restore backups' USING ERRCODE = '42501'; END IF;
  IF d IS NULL OR p_backup->>'version' IS NULL THEN RAISE EXCEPTION 'Invalid backup file structure'; END IF;
  PERFORM set_config('ff.suppress_audit', 'on', true);

  IF jsonb_typeof(d->'customers') = 'array' THEN
    DELETE FROM customers_ff2024 WHERE true;
    INSERT INTO customers_ff2024 (id, name, company, email, phone, bill_to_address, ship_to_address, accounts_payable_email)
    SELECT COALESCE(NULLIF(c->>'id','')::uuid, gen_random_uuid()), COALESCE(c->>'name',''), COALESCE(c->>'company',''),
           COALESCE(c->>'email',''), COALESCE(c->>'phone',''), COALESCE(c->>'billToAddress',''),
           COALESCE(c->>'shipToAddress',''), COALESCE(c->>'accountsPayableEmail','')
    FROM jsonb_array_elements(d->'customers') c;
    GET DIAGNOSTICS n_cust = ROW_COUNT;
  END IF;

  IF jsonb_typeof(d->'invoices') = 'array' THEN
    DELETE FROM invoice_items_ff2024 WHERE true;
    DELETE FROM invoices_ff2024 WHERE true;

    -- Park the sequence above every number the backup carries, so numbers handed out
    -- to older backups that lack them can never collide.
    SELECT COALESCE(max(COALESCE(NULLIF(i->>'invoiceNumber','')::bigint, NULLIF(i->>'invoice_number','')::bigint)), 0)
      INTO v_max FROM jsonb_array_elements(d->'invoices') i;
    IF v_max < 1 THEN PERFORM setval('invoice_number_seq', 1, false); ELSE PERFORM setval('invoice_number_seq', v_max, true); END IF;

    INSERT INTO invoices_ff2024 (id, invoice_number, date, po_number, sales_rep, sales_rep_id, transaction_type,
      customer_name, company, customer_email, customer_phone, accounts_payable_email,
      bill_to_address, ship_to_address, shipping_cost, additional_info, status,
      tax_rate, subtotal, tax, grand_total, archived, created_at, updated_at)
    SELECT COALESCE(NULLIF(i->>'id','')::uuid, gen_random_uuid()),
      COALESCE(NULLIF(i->>'invoiceNumber','')::bigint, NULLIF(i->>'invoice_number','')::bigint),
      NULLIF(i->>'date','')::date, i->>'poNumber',
      COALESCE(u.name, i->>'salesRep'), u.id,
      i->>'transactionType', i->>'customerName', COALESCE(i->>'company',''),
      COALESCE(i->>'customerEmail',''), COALESCE(i->>'customerPhone',''), COALESCE(i->>'accountsPayableEmail',''),
      COALESCE(i->>'billToAddress',''), COALESCE(i->>'shipToAddress',''),
      COALESCE(NULLIF(i->>'shippingCost','')::numeric, 0), COALESCE(i->>'additionalInfo',''),
      COALESCE(NULLIF(i->>'status',''), 'pending'),
      COALESCE(NULLIF(i->>'taxRate','')::numeric, 8.0), COALESCE(NULLIF(i->>'subtotal','')::numeric, 0),
      COALESCE(NULLIF(i->>'tax','')::numeric, 0), COALESCE(NULLIF(i->>'grandTotal','')::numeric, 0),
      COALESCE((i->>'archived')::boolean, false),
      COALESCE(NULLIF(i->>'createdAt','')::timestamptz, now()), COALESCE(NULLIF(i->>'updatedAt','')::timestamptz, now())
    FROM jsonb_array_elements(d->'invoices') i
    LEFT JOIN LATERAL (
      SELECT x.id, x.name FROM (
        SELECT id, name, 1 AS pri FROM users_ff2024
          WHERE id = COALESCE(NULLIF(i->>'salesRepId','')::uuid, NULLIF(i->>'sales_rep_id','')::uuid)
        UNION ALL
        SELECT id, name, 2 FROM users_ff2024 WHERE name = i->>'salesRep'
      ) x ORDER BY x.pri LIMIT 1
    ) u ON true;
    GET DIAGNOSTICS n_inv = ROW_COUNT;

    INSERT INTO invoice_items_ff2024 (invoice_id, mfg, part_number, description, qty, unit_price, taxable)
    SELECT (i->>'id')::uuid, COALESCE(it->>'mfg',''), COALESCE(it->>'partNumber',''), COALESCE(it->>'description',''),
           COALESCE(NULLIF(it->>'qty','')::numeric, 0), COALESCE(NULLIF(it->>'unitPrice','')::numeric, 0),
           COALESCE((it->>'taxable')::boolean, true)
    FROM jsonb_array_elements(d->'invoices') i,
         jsonb_array_elements(CASE WHEN jsonb_typeof(i->'items') = 'array' THEN i->'items' ELSE '[]'::jsonb END) it
    WHERE NULLIF(i->>'id','') IS NOT NULL;
    GET DIAGNOSTICS n_items = ROW_COUNT;
  END IF;

  IF d->'settings'->>'taxRate' IS NOT NULL THEN
    INSERT INTO settings_ff2024 (key, value) VALUES ('tax_rate', d->'settings'->>'taxRate')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END IF;

  PERFORM set_config('ff.suppress_audit', 'off', true);
  INSERT INTO invoice_events (action, actor_id, actor_name, changes)
  VALUES ('restored', ff_user_id(), COALESCE(ff_name(), 'system'),
          jsonb_build_object('customers', n_cust, 'invoices', n_inv, 'items', n_items,
                             'backup_timestamp', p_backup->>'timestamp'));

  RETURN jsonb_build_object('customers', n_cust, 'invoices', n_inv, 'items', n_items);
END $$;

REVOKE ALL ON FUNCTION public.restore_backup(jsonb), public.save_invoice(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_backup(jsonb), public.save_invoice(jsonb, jsonb) TO authenticated;
