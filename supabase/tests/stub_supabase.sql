-- Minimal stand-ins for Supabase so the migrations can run on plain Postgres (CI / local).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

-- Pre-existing app tables (the real project created these outside the migrations folder)
CREATE TABLE users_ff2024 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE, name text, email text, phone text,
  role text, password_hash text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE customers_ff2024 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text, phone text,
  bill_to_address text, ship_to_address text, accounts_payable_email text, created_at timestamptz DEFAULT now());
CREATE TABLE invoices_ff2024 (id uuid PRIMARY KEY, date date, po_number text, sales_rep text, transaction_type text,
  customer_name text, company text, customer_email text, customer_phone text, accounts_payable_email text,
  bill_to_address text, ship_to_address text, shipping_cost numeric, additional_info text, status text,
  tax_rate numeric, subtotal numeric, tax numeric, grand_total numeric, archived boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE invoice_items_ff2024 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid REFERENCES invoices_ff2024(id),
  mfg text, part_number text, description text, qty numeric, unit_price numeric, taxable boolean);
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
