# Fire Force Invoice System

React + Vite app for creating and managing sales invoices, backed by Supabase (Postgres + Auth + Edge Functions).
Two roles: **salesman** (own invoices, customers) and **office** (everything, plus users, reports, backups, settings).

## Setup

```bash
npm install
cp .env.example .env     # fill in your Supabase URL + anon key
npm run dev
```

`.env`:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## Database & auth

Migrations live in `src/supabase/migrations/` (apply in filename order). Security model:

- Sign-in is Supabase Auth. Usernames map to `username@fireforce.local`; the role comes from `users_ff2024`.
- Row Level Security: anonymous users get nothing. Salesmen only see/edit invoices where `sales_rep_id` is theirs;
  office has full access. Invoices are saved/deleted/restored through RPCs (`save_invoice`, `delete_invoice`,
  `restore_backup`) so each operation is one transaction; totals are recomputed on the server.
- Creating/resetting/deleting salesman accounts needs the service key, so it runs in the `manage-users`
  Edge Function (`supabase functions deploy manage-users`). It only accepts office callers.

### First-time / migrating an existing install

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OFFICE_USERNAME=ffoffice1 OFFICE_PASSWORD='<strong password>' \
  node scripts/bootstrap-auth.mjs
```

Accounts created by the script (and by an admin password reset) must choose their own password at first sign-in.

Then apply the migrations. Never put the service-role key in the browser or in `.env` files that ship with the app.

## Invoice numbers & audit trail

- Every invoice gets a database-assigned sequential number shown as `FF-000123` (existing invoices are
  numbered oldest-first by the migration). Salesmen cannot choose or change it; backups keep their numbers.
- `invoice_events` records who created, edited (with before/after values and line-item counts), changed the
  status of, archived or deleted each invoice, and each backup restore. It is written only by triggers and can't be
  edited or deleted through the API. History button per invoice; Office → Activity shows everything, including
  deleted invoices.

## Accounts & passwords

- Office → Users can create **salesman or office** accounts, reset passwords, and delete accounts
  (not yourself, and never the last office account).
- Admin-set passwords are temporary: the user is prompted to choose their own at next sign-in.
  (The flag lives in Supabase `user_metadata`; it is a UX prompt, not a security boundary.)
- Anyone can change their own password from the header (current password required).
- There is no email-based "forgot password": login emails are synthetic (`@fireforce.local`), so an office
  admin resets it from Users. Real email reset would need an email provider and per-user real addresses.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Lint + production build |
| `npm test` | Unit tests (Vitest) |
| `npm run test:db` | Applies all migrations to a throwaway Postgres and runs RLS/RPC tests (`PGHOST`/`PGUSER` must point at a superuser connection) |

CI (`.github/workflows/ci.yml`) runs lint, unit tests, build, the database tests, and a backup/restore round trip.

## Backups

**In-app (Office → Backup):** exports JSON (no passwords). Restore replaces customers, invoices and the tax rate in a
single transaction (all-or-nothing) and never touches user accounts; manage those under Users. Handy for quick
exports, but it isn't a disaster-recovery plan, because someone has to remember to do it.

### Server-side backups (automatic)

`.github/workflows/backup.yml` runs nightly (07:17 UTC, and on demand from the Actions tab). It dumps the app schema +
data and the Supabase Auth accounts with `pg_dump`, encrypts the bundle (AES-256), **restores it into a scratch
Postgres to prove it works**, and keeps the encrypted file as a workflow artifact for 90 days. If any step fails,
the run fails and GitHub emails you.

One-time setup, in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Postgres connection string. GitHub runners are IPv4-only, so use the **session pooler** URL from Supabase → Project Settings → Database → Connection string (`...pooler.supabase.com:5432`), not the direct host. Use the `postgres` user. |
| `BACKUP_PASSPHRASE` | A long random passphrase. **Also store it in your password manager**: without it backups can't be read. |

Then run the workflow once by hand (Actions → Nightly database backup → Run workflow) and confirm it's green.

Good to know:
- Backups contain customer data and account password hashes, which is why they're encrypted. Treat the passphrase and the
  `SUPABASE_DB_URL` secret as sensitive.
- GitHub disables scheduled workflows after 60 days without repository activity. A green run every so often (or any
  commit) keeps it alive; check the Actions tab if you haven't touched the repo in a while.
- Artifacts expire after 90 days. For longer retention, download a monthly one and keep it elsewhere. If you're on a
  paid Supabase plan, also enable its built-in daily backups / point-in-time recovery; they complement this.
- To restore, follow [`docs/RESTORE.md`](docs/RESTORE.md).
- Run by hand: `DATABASE_URL=... BACKUP_PASSPHRASE=... bash scripts/backup-db.sh` then
  `bash scripts/verify-backup.sh <file>` (needs a scratch Postgres superuser connection in `PG*` env vars).
