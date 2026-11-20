/*
# Main admin (owner) role

Three levels:
  owner    "Main Admin"   - everything an Office Admin can do, plus managing people and their levels
  office   "Office Admin" - invoices, customers, reports, backups, settings (cannot manage users)
  salesman "Sales"        - own invoices and customers

How it works:
- ff_role() reports an owner as 'office', so every existing policy/function that grants office-level data access
  automatically covers the owner too.
- ff_is_owner() is used where only the main admin may act: writing to users_ff2024.
- Exactly one owner can exist (partial unique index). To hand ownership to someone else, change it in SQL.

After applying: promote yourself once, e.g.
  update users_ff2024 set role = 'owner' where email = 'you@example.com';
*/

-- Allow the new value (drop whatever role CHECK the table has, then recreate it)
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.users_ff2024'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users_ff2024 DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE users_ff2024 ADD CONSTRAINT users_ff2024_role_check CHECK (role IN ('owner', 'office', 'salesman'));

CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner ON users_ff2024 ((true)) WHERE role = 'owner';

CREATE OR REPLACE FUNCTION public.ff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT CASE WHEN role = 'owner' THEN 'office' ELSE role END FROM users_ff2024 WHERE auth_id = auth.uid() LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.ff_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT COALESCE((SELECT role = 'owner' FROM users_ff2024 WHERE auth_id = auth.uid() LIMIT 1), false) $$;

REVOKE ALL ON FUNCTION public.ff_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ff_is_owner() TO authenticated;

-- Only the main admin can write to users (the manage-users function also enforces this)
DROP POLICY IF EXISTS users_write ON users_ff2024;
CREATE POLICY users_write ON users_ff2024 FOR ALL TO authenticated
  USING (ff_is_owner()) WITH CHECK (ff_is_owner());
