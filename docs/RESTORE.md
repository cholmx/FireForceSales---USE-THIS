# Restoring from a server backup

Backups are produced nightly by `.github/workflows/backup.yml` (or by hand with `scripts/backup-db.sh`) and are
AES-256 encrypted files named `fireforce-<timestamp>.tgz.enc`. Each contains:

| File | What |
| --- | --- |
| `public.dump` | App schema + data: invoices, items, customers, users, audit log, settings, functions, RLS policies |
| `auth.dump` | Supabase Auth accounts (`auth.users`, `auth.identities`), so everyone's existing password keeps working |
| `manifest.json` | Row counts at backup time |

You need the **backup passphrase** (the `BACKUP_PASSPHRASE` secret). Store a copy in your password manager. Without
it a backup cannot be read.

## 1. Get and check the backup

Download the artifact from GitHub → Actions → *Nightly database backup* → the run → *Artifacts* (unzip it).

```bash
export BACKUP_PASSPHRASE='...'
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in fireforce-XXXX.tgz.enc -out bundle.tgz -pass env:BACKUP_PASSPHRASE
mkdir restore && tar -C restore -xzf bundle.tgz && cat restore/manifest.json
```

(Every nightly backup was already test-restored by the workflow before being kept, so a green run means the file
restores.)

## 2. Restore into a NEW Supabase project (recommended, e.g. after data loss or corruption)

Restoring into a fresh project avoids clobbering anything and lets you compare before switching over.

1. Create a new Supabase project. Use the same Postgres major version.
2. Get its **direct** or session-pooler connection string (`$NEW_DB_URL`).
3. Restore accounts first (the app schema references them):
   ```bash
   pg_restore --no-owner --no-privileges --data-only --disable-triggers -d "$NEW_DB_URL" restore/auth.dump
   ```
4. Restore the app schema and data. The list filter keeps `pg_restore` from dropping/recreating the `public`
   schema itself (Supabase's API roles depend on its grants):
   ```bash
   pg_restore -l restore/public.dump | grep -vE ' SCHEMA - public |COMMENT - SCHEMA public' > restore/public.list
   pg_restore --no-owner --no-privileges -c --if-exists -L restore/public.list -d "$NEW_DB_URL" restore/public.dump
   ```
   Errors about objects that "do not exist" during the clean phase are harmless; anything else is not, so read the
   output. Then re-grant API access if the dashboard shows tables as inaccessible:
   `grant usage on schema public to anon, authenticated; grant all on all tables in schema public to authenticated;`
   (anonymous users must keep **no** access; the RLS policies and the `REVOKE ... FROM anon` in the migrations enforce that).
5. Re-deploy the Edge Function to the new project: `supabase functions deploy manage-users --project-ref <new>`.
6. Point the app at it: set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` to the new project and redeploy.
7. Sign in as an office user and spot-check invoices, the Activity page and a salesman login.

Invoice numbers continue from where they left off (the sequence is part of the dump).

## 3. Restore into the SAME project (only if you must)

This **replaces current data**. Take a fresh backup first (`scripts/backup-db.sh`) so you can undo it, and stop
users from working. Then run step 4 above against the existing project's connection string, using the same filtered list. Do not re-run step 3
unless auth rows were lost; restoring over existing accounts will report duplicate-key errors.

## Partial recovery without a full restore

Need a single deleted invoice? Restore into a scratch Postgres (see `scripts/verify-backup.sh` for the recipe), then
copy the rows you need. The Activity page records what was deleted and by whom.
