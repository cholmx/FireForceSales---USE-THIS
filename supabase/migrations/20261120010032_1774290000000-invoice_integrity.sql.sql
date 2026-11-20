/*
# Invoice integrity

1. invoices_ff2024.sales_rep_id (FK to users_ff2024) becomes the ownership key for RLS,
   so renaming a rep no longer orphans their invoices. sales_rep (text) stays as the
   display name and is kept in sync by a trigger.
2. save_invoice / delete_invoice RPCs write the invoice and its line items in ONE
   transaction, and recompute totals on the server.
3. restore_backup RPC replaces customers/invoices/settings in ONE transaction
   (a failure rolls everything back). Office only. Accounts are never touched.

All functions are SECURITY INVOKER, so the RLS policies still apply to the caller.
*/

ALTER TABLE invoices_ff2024
  ADD COLUMN IF NOT EXISTS sales_rep_id uuid REFERENCES users_ff2024(id) ON DELETE SET NULL;

-- Backfill from the old name match (only where the name is unambiguous)
UPDATE invoices_ff2024 i
SET sales_rep_id = u.id
FROM users_ff2024 u
WHERE i.sales_rep_id IS NULL
  AND u.name = i.sales_rep
  AND (SELECT count(*) FROM users_ff2024 x WHERE x.name = i.sales_rep) = 1;

CREATE INDEX IF NOT EXISTS invoices_sales_rep_id_idx ON invoices_ff2024(sales_rep_id);

CREATE OR REPLACE FUNCTION public.ff_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id FROM users_ff2024 WHERE auth_id = auth.uid() LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.ff_user_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ff_user_id() TO authenticated;

-- Keep the display name on invoices in sync when a user is renamed
CREATE OR REPLACE FUNCTION public.ff_sync_rep_name() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE invoices_ff2024 SET sales_rep = NEW.name WHERE sales_rep_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ff_sync_rep_name ON users_ff2024;
CREATE TRIGGER ff_sync_rep_name AFTER UPDATE OF name ON users_ff2024
  FOR EACH ROW EXECUTE FUNCTION public.ff_sync_rep_name();

-- Ownership by id
DROP POLICY IF EXISTS invoices_read   ON invoices_ff2024;
DROP POLICY IF EXISTS invoices_insert ON invoices_ff2024;
DROP POLICY IF EXISTS invoices_update ON invoices_ff2024;
CREATE POLICY invoices_read ON invoices_ff2024 FOR SELECT TO authenticated
  USING (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep_id = ff_user_id()));
CREATE POLICY invoices_insert ON invoices_ff2024 FOR INSERT TO authenticated
  WITH CHECK (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep_id = ff_user_id()));
CREATE POLICY invoices_update ON invoices_ff2024 FOR UPDATE TO authenticated
  USING (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep_id = ff_user_id()))
  WITH CHECK (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep_id = ff_user_id()));

-- Shared totals math: cents-rounded per line, tax on taxable lines only
CREATE OR REPLACE FUNCTION public.ff_totals(p_items jsonb, p_rate numeric, p_shipping numeric,
  OUT subtotal numeric, OUT tax numeric, OUT grand_total numeric)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE taxable numeric;
BEGIN
  SELECT COALESCE(sum(round((i->>'qty')::numeric * (i->>'unitPrice')::numeric, 2)), 0),
         COALESCE(sum(CASE WHEN COALESCE((i->>'taxable')::boolean, true)
                      THEN round((i->>'qty')::numeric * (i->>'unitPrice')::numeric, 2) ELSE 0 END), 0)
    INTO subtotal, taxable
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) i;
  tax := round(taxable * COALESCE(p_rate, 0) / 100, 2);
  grand_total := subtotal + tax + COALESCE(p_shipping, 0);
END $$;

-- Create or update an invoice with its items atomically. Returns the invoice id.
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
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found or not allowed' USING ERRCODE = '42501'; END IF;
    DELETE FROM invoice_items_ff2024 WHERE invoice_id = v_id;
  END IF;

  INSERT INTO invoice_items_ff2024 (invoice_id, mfg, part_number, description, qty, unit_price, taxable)
  SELECT v_id, i->>'mfg', i->>'partNumber', i->>'description',
         (i->>'qty')::numeric, (i->>'unitPrice')::numeric, COALESCE((i->>'taxable')::boolean, true)
  FROM jsonb_array_elements(p_items) i;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.delete_invoice(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF ff_role() IS DISTINCT FROM 'office' THEN RAISE EXCEPTION 'Only office can delete invoices' USING ERRCODE = '42501'; END IF;
  DELETE FROM invoice_items_ff2024 WHERE invoice_id = p_id;
  DELETE FROM invoices_ff2024 WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
END $$;

-- Replace customers / invoices / tax rate from a backup file, all-or-nothing.
CREATE OR REPLACE FUNCTION public.restore_backup(p_backup jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  d jsonb := p_backup->'data';
  n_cust int := 0; n_inv int := 0; n_items int := 0;
BEGIN
  IF ff_role() IS DISTINCT FROM 'office' THEN RAISE EXCEPTION 'Only office can restore backups' USING ERRCODE = '42501'; END IF;
  IF d IS NULL OR p_backup->>'version' IS NULL THEN RAISE EXCEPTION 'Invalid backup file structure'; END IF;

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
    INSERT INTO invoices_ff2024 (id, date, po_number, sales_rep, sales_rep_id, transaction_type,
      customer_name, company, customer_email, customer_phone, accounts_payable_email,
      bill_to_address, ship_to_address, shipping_cost, additional_info, status,
      tax_rate, subtotal, tax, grand_total, archived, created_at, updated_at)
    SELECT COALESCE(NULLIF(i->>'id','')::uuid, gen_random_uuid()),
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

  RETURN jsonb_build_object('customers', n_cust, 'invoices', n_inv, 'items', n_items);
END $$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb), public.delete_invoice(uuid),
  public.restore_backup(jsonb), public.ff_totals(jsonb, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb), public.delete_invoice(uuid),
  public.restore_backup(jsonb), public.ff_totals(jsonb, numeric, numeric) TO authenticated;
