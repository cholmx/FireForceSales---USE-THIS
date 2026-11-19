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

CI (`.github/workflows/ci.yml`) runs lint, unit tests, build, and the database tests.

## Backups

Office → Backup exports JSON (no passwords). Restore replaces customers, invoices and the tax rate in a single
transaction (all-or-nothing) and never touches user accounts; manage those under Users.
