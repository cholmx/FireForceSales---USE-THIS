/*
# Create base tables for Fire Force invoice system

1. New Tables
   - `users_ff2024` — app accounts (salesman / office) shown in rep dropdowns
   - `customers_ff2024` — customer directory
   - `invoices_ff2024` — invoice headers with computed totals
   - `invoice_items_ff2024` — line items belonging to an invoice
2. Security
   - RLS enabled on every table; policies are (re)created by later migrations,
     so the tables stay locked until the secure-auth migration runs.
   - SELECT/INSERT/UPDATE/DELETE granted to `authenticated` (the app requires sign-in);
     `anon` gets no grants.
*/

CREATE TABLE IF NOT EXISTS users_ff2024 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE,
  name text NOT NULL,
  email text,
  phone text,
  role text NOT NULL DEFAULT 'salesman' CHECK (role IN ('salesman', 'office')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers_ff2024 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  company text DEFAULT '',
  email text DEFAULT '',
  phone text DEFAULT '',
  bill_to_address text DEFAULT '',
  ship_to_address text DEFAULT '',
  accounts_payable_email text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices_ff2024 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date,
  po_number text,
  sales_rep text,
  transaction_type text,
  customer_name text,
  company text DEFAULT '',
  customer_email text DEFAULT '',
  customer_phone text DEFAULT '',
  accounts_payable_email text DEFAULT '',
  bill_to_address text DEFAULT '',
  ship_to_address text DEFAULT '',
  shipping_cost numeric DEFAULT 0,
  additional_info text,
  status text DEFAULT 'pending',
  tax_rate numeric DEFAULT 8.0,
  subtotal numeric DEFAULT 0,
  tax numeric DEFAULT 0,
  grand_total numeric DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_items_ff2024 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices_ff2024(id) ON DELETE CASCADE,
  mfg text DEFAULT '',
  part_number text DEFAULT '',
  description text DEFAULT '',
  qty numeric DEFAULT 0,
  unit_price numeric DEFAULT 0,
  taxable boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items_ff2024(invoice_id);

ALTER TABLE users_ff2024 ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers_ff2024 ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices_ff2024 ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items_ff2024 ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON users_ff2024 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers_ff2024 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices_ff2024 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_items_ff2024 TO authenticated;
