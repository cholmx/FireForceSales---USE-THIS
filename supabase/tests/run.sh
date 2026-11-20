#!/usr/bin/env bash
# Applies supabase/migrations/*.sql (base tables + everything after) to a throwaway database, then runs the
# RLS/RPC tests. Usage: PGHOST=... PGUSER=... supabase/tests/run.sh   (needs a superuser connection)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=ff_rls_test
psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
export PGDATABASE=$DB
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/stub_auth.sql    # stand-ins for Supabase's auth schema + roles
for f in supabase/migrations/*.sql; do echo "== $f"; psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/rls.test.sql
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/bids.test.sql
