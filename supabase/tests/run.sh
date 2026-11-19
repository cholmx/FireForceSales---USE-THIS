#!/usr/bin/env bash
# Runs the migrations + RLS tests against a throwaway database.
# Usage: PGHOST=... PGUSER=... supabase/tests/run.sh   (needs a superuser connection)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=ff_rls_test
psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
export PGDATABASE=$DB
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/stub_auth.sql
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/stub_tables.sql
for f in src/supabase/migrations/*.sql; do echo "== $f"; psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/rls.test.sql
