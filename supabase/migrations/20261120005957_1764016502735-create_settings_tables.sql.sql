/*
# Create settings and office info tables
1. New Tables
   - `settings_ff2024` (Stores app settings like tax rate)
   - `office_info_ff2024` (Stores office contact info)
2. Security
   - Enable RLS on both tables
   - Policies are (re)created by later migrations; grants to `authenticated` added here
*/

-- Settings Table
CREATE TABLE IF NOT EXISTS settings_ff2024 (
  key text PRIMARY KEY,
  value text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE settings_ff2024 ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON settings_ff2024 TO authenticated;

-- Office Info Table
CREATE TABLE IF NOT EXISTS office_info_ff2024 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text,
  address text,
  phone text,
  emergency_phone text,
  email text,
  service_email text,
  username text,
  password_hash text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE office_info_ff2024 ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON office_info_ff2024 TO authenticated;
