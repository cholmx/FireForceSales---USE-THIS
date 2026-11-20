/*
# Secure auth + role-based RLS

Replaces the anon-open policies with policies keyed to Supabase Auth.

1. users_ff2024 gets auth_id (links to auth.users); passwords live only in Supabase Auth.
2. Helper functions ff_role() / ff_name() (SECURITY DEFINER) resolve the caller's role.
3. All policies on app tables are dropped and recreated:
   - office: full access
   - salesman: read/create/update only their own invoices (sales_rep = their name),
     read/create/update customers, read settings, office info and users.
   - anon: no access.
4. Legacy password columns on office_info_ff2024 are dropped.

Run scripts/bootstrap-auth.mjs BEFORE relying on this (it creates auth accounts and
clears users_ff2024.password_hash).
*/

ALTER TABLE users_ff2024 ADD COLUMN IF NOT EXISTS auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;
-- Legacy plaintext column: relax it only if this database still has it (fresh installs don't)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users_ff2024' AND column_name = 'password_hash') THEN
    ALTER TABLE users_ff2024 ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;
ALTER TABLE office_info_ff2024 DROP COLUMN IF EXISTS password_hash;
ALTER TABLE office_info_ff2024 DROP COLUMN IF EXISTS username;

CREATE OR REPLACE FUNCTION public.ff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT role FROM users_ff2024 WHERE auth_id = auth.uid() LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.ff_name() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT name FROM users_ff2024 WHERE auth_id = auth.uid() LIMIT 1 $$;

REVOKE ALL ON FUNCTION public.ff_role(), public.ff_name() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ff_role(), public.ff_name() TO authenticated;

-- Drop every existing policy and remove anon table access
DO $$
DECLARE r record; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['settings_ff2024','office_info_ff2024','users_ff2024',
    'customers_ff2024','invoices_ff2024','invoice_items_ff2024']
  LOOP
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t
    LOOP
      EXECUTE format('DROP POLICY %I ON %I', r.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
  END LOOP;
END $$;

-- settings / office info: everyone signed in reads, office writes
CREATE POLICY settings_read  ON settings_ff2024 FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_write ON settings_ff2024 FOR ALL TO authenticated
  USING (ff_role() = 'office') WITH CHECK (ff_role() = 'office');

CREATE POLICY office_info_read  ON office_info_ff2024 FOR SELECT TO authenticated USING (true);
CREATE POLICY office_info_write ON office_info_ff2024 FOR ALL TO authenticated
  USING (ff_role() = 'office') WITH CHECK (ff_role() = 'office');

-- users: readable by signed-in users (rep dropdowns); writes only via the
-- manage-users Edge Function (service role) or office
CREATE POLICY users_read  ON users_ff2024 FOR SELECT TO authenticated USING (true);
CREATE POLICY users_write ON users_ff2024 FOR ALL TO authenticated
  USING (ff_role() = 'office') WITH CHECK (ff_role() = 'office');

-- customers
CREATE POLICY customers_read   ON customers_ff2024 FOR SELECT TO authenticated USING (ff_role() IS NOT NULL);
CREATE POLICY customers_insert ON customers_ff2024 FOR INSERT TO authenticated WITH CHECK (ff_role() IS NOT NULL);
CREATE POLICY customers_update ON customers_ff2024 FOR UPDATE TO authenticated
  USING (ff_role() IS NOT NULL) WITH CHECK (ff_role() IS NOT NULL);
CREATE POLICY customers_delete ON customers_ff2024 FOR DELETE TO authenticated USING (ff_role() = 'office');

-- invoices
CREATE POLICY invoices_read ON invoices_ff2024 FOR SELECT TO authenticated
  USING (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep = ff_name()));
CREATE POLICY invoices_insert ON invoices_ff2024 FOR INSERT TO authenticated
  WITH CHECK (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep = ff_name()));
CREATE POLICY invoices_update ON invoices_ff2024 FOR UPDATE TO authenticated
  USING (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep = ff_name()))
  WITH CHECK (ff_role() = 'office' OR (ff_role() = 'salesman' AND sales_rep = ff_name()));
CREATE POLICY invoices_delete ON invoices_ff2024 FOR DELETE TO authenticated USING (ff_role() = 'office');

-- invoice items follow their parent invoice (parent's RLS applies to the subquery)
CREATE POLICY items_all ON invoice_items_ff2024 FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM invoices_ff2024 i WHERE i.id = invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM invoices_ff2024 i WHERE i.id = invoice_id));

INSERT INTO settings_ff2024 (key, value) VALUES ('tax_rate', '8.0') ON CONFLICT (key) DO NOTHING;
