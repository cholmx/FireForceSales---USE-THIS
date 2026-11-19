#!/usr/bin/env bash
# Proves a backup is restorable: decrypts it, restores the app schema+data into a throwaway database
# and compares row counts with the manifest. Fails loudly if anything is off.
#
#   BACKUP_PASSPHRASE=... PGHOST=... PGUSER=... [PGPASSWORD=...] scripts/verify-backup.sh <file.tgz.enc>
#
# The PG* variables must point at a SUPERUSER connection on a scratch Postgres server (never production):
# a database named ff_backup_verify is created and dropped.
set -euo pipefail
FILE="${1:?usage: verify-backup.sh <backup.tgz.enc>}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
cd "$(dirname "$0")/.."
DB=ff_backup_verify
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$FILE" -out "$WORK/bundle.tgz" -pass env:BACKUP_PASSPHRASE
tar -C "$WORK" -xzf "$WORK/bundle.tgz"
for f in public.dump auth.dump manifest.json; do [ -s "$WORK/$f" ] || { echo "FAIL: $f missing from backup"; exit 1; }; done

psql -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
export PGDATABASE=$DB
psql -q -v ON_ERROR_STOP=1 -f supabase/tests/stub_auth.sql

# Restore everything except the FK to auth.users (the auth tables are checked separately below)
# and the 'public' schema itself, which a fresh database already has.
pg_restore -l "$WORK/public.dump" | grep -vE 'users_ff2024_auth_id_fkey| SCHEMA - public |COMMENT - SCHEMA public' > "$WORK/restore.list"
pg_restore --exit-on-error --no-owner --no-privileges --disable-triggers -L "$WORK/restore.list" -d "$DB" "$WORK/public.dump"

fail=0
for table in users_ff2024 customers_ff2024 invoices_ff2024 invoice_items_ff2024 invoice_events settings_ff2024; do
  want=$(python3 -c "import json,sys;print(json.load(open('$WORK/manifest.json'))['counts']['$table'])")
  got=$(psql -At -c "SELECT count(*) FROM public.$table")
  diff=$(( want > got ? want - got : got - want ))
  # live data can change between the count and the dump; allow a few rows of drift
  if [ "$diff" -gt 5 ]; then echo "FAIL: $table has $got rows after restore, manifest says $want"; fail=1; else echo "ok  $table: $got rows (manifest $want)"; fi
done

# auth accounts: count rows in the dump
want=$(python3 -c "import json;print(json.load(open('$WORK/manifest.json'))['counts']['auth_users'])")
got=$(pg_restore -a -n auth -t users -f - "$WORK/auth.dump" | awk '/^COPY auth.users/{f=1;next} /^\\\./{f=0} f' | wc -l | tr -d ' ')
diff=$(( want > got ? want - got : got - want ))
if [ "$diff" -gt 5 ]; then echo "FAIL: auth.dump has $got users, manifest says $want"; fail=1; else echo "ok  auth.users: $got accounts in dump (manifest $want)"; fi

# schema sanity: the pieces the app depends on came back
for obj in "public.save_invoice(jsonb,jsonb)" "public.restore_backup(jsonb)"; do
  [ "$(psql -At -c "SELECT to_regprocedure('$obj') IS NOT NULL")" = "t" ] || { echo "FAIL: function $obj missing after restore"; fail=1; }
done
[ "$(psql -At -c "SELECT count(*) FROM pg_policies WHERE schemaname='public'")" -gt 0 ] || { echo "FAIL: no RLS policies after restore"; fail=1; }

[ "$fail" -eq 0 ] && echo "BACKUP VERIFIED: $FILE" || { echo "BACKUP VERIFICATION FAILED"; exit 1; }
