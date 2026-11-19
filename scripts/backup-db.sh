#!/usr/bin/env bash
# Encrypted server-side backup of the Supabase database.
#
#   DATABASE_URL=postgresql://... BACKUP_PASSPHRASE=... scripts/backup-db.sh [output-dir]
#
# Produces <output-dir>/fireforce-<UTC timestamp>.tgz.enc containing:
#   public.dump   app schema + data (invoices, customers, users, audit log, settings, functions, policies)
#   auth.dump     Supabase Auth accounts (auth.users, auth.identities) so logins survive a restore
#   manifest.json row counts at backup time (used by verify-backup.sh)
# The bundle is AES-256 encrypted; keep the passphrase somewhere safe, WITHOUT it a backup is unreadable.
# Needs pg_dump/psql at least as new as the server (use the pooler's session-mode URL on IPv4-only hosts).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
OUT="${1:-backups}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pg_dump "$DATABASE_URL" --format=custom --schema=public --no-owner --no-privileges --file "$WORK/public.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges -t auth.users -t auth.identities --file "$WORK/auth.dump"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "
  SELECT json_build_object(
    'created_at', now(),
    'server_version', current_setting('server_version'),
    'counts', json_build_object(
      'users_ff2024',         (SELECT count(*) FROM public.users_ff2024),
      'customers_ff2024',     (SELECT count(*) FROM public.customers_ff2024),
      'invoices_ff2024',      (SELECT count(*) FROM public.invoices_ff2024),
      'invoice_items_ff2024', (SELECT count(*) FROM public.invoice_items_ff2024),
      'invoice_events',       (SELECT count(*) FROM public.invoice_events),
      'settings_ff2024',      (SELECT count(*) FROM public.settings_ff2024),
      'auth_users',           (SELECT count(*) FROM auth.users)
    )
  )" > "$WORK/manifest.json"

tar -C "$WORK" -czf "$WORK/bundle.tgz" public.dump auth.dump manifest.json
FILE="$OUT/fireforce-$STAMP.tgz.enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in "$WORK/bundle.tgz" -out "$FILE" -pass env:BACKUP_PASSPHRASE
echo "Wrote $FILE ($(du -h "$FILE" | cut -f1))"
sha256sum "$FILE" 2>/dev/null || shasum -a 256 "$FILE"
