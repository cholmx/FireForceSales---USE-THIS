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

Migrations live in `supabase/migrations/` (apply in filename order; the first one creates the base tables). Security model:

- Sign-in is Supabase Auth with an **email address** and password; the access level comes from `users_ff2024`. (Typing a
  legacy username with no `@` still works: it maps to the `username@fireforce.local` address those accounts were created with.)
- Row Level Security: anonymous users get nothing. Salesmen only see/edit invoices where `sales_rep_id` is theirs;
  office has full access. Invoices are saved/deleted/restored through RPCs (`save_invoice`, `delete_invoice`,
  `restore_backup`) so each operation is one transaction; totals are recomputed on the server.
- Creating/resetting/deleting salesman accounts needs the service key, so it runs in the `manage-users`
  Edge Function (`supabase functions deploy manage-users`). It only accepts office callers.

### Access levels

| Level | Name in the app | Can do |
| --- | --- | --- |
| `owner` | **Main Admin** | Everything an Office Admin can, plus add/edit/remove people, change their level, reset passwords. Exactly one exists. |
| `office` | **Office Admin** | All invoices, customers, reports, backups, settings. Cannot manage users. |
| `salesman` | **Sales** | Their own invoices, plus customers. |

Only the Main Admin sees Office -> Users, and the `manage-users` function and the database policies enforce it (not just the UI).
Ownership can't be handed out in the app; to move it, change it in SQL.

### First-time setup

1. Apply the migrations in `supabase/migrations/` (Bolt does this for you; otherwise paste each file into the Supabase SQL editor in filename order).
2. Deploy the `manage-users` Edge Function.
3. Create the Main Admin, either with the script (run locally; needs the service-role key):

   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OFFICE_EMAIL=you@example.com OFFICE_PASSWORD='<strong password>' \
     node scripts/bootstrap-auth.mjs
   ```

   or by hand: Supabase dashboard -> Authentication -> Users -> Add user (your email, a password, auto-confirm), then in the SQL editor:

   ```sql
   insert into users_ff2024 (username, name, role, email, auth_id)
   values ('you@example.com', 'Your Name', 'owner', 'you@example.com', '<the new auth user id>');
   ```

   If you already have an Office account you want to promote: `update users_ff2024 set role = 'owner' where email = 'you@example.com';`
4. Sign in and add everyone else under Office -> Users (Office Admin or Sales).

Accounts created with an admin-set password (and admin password resets) must choose their own password at first sign-in.
Never put the service-role key in the browser or in `.env` files that ship with the app.

### Email (invites and password resets) via Resend

Office -> Users -> Add User emails an **invite** by default (the person clicks the link and chooses their own password), and
"Forgot password?" on the sign-in page emails a reset link. The `manage-users` Edge Function sends these through
[Resend](https://resend.com), so Supabase's own mailer and SMTP settings are not used.

One-time setup:

1. **Resend -> Domains:** add and verify your sending domain (e.g. `fforce.com`) by adding the DNS records Resend shows.
   You can only send from a verified domain (a Gmail address can't be the sender).
2. **Resend -> API Keys:** create a key with sending access.
3. **Supabase -> Edge Functions -> Secrets** (or Bolt's secrets screen): add
   - `RESEND_API_KEY` = the key (required)
   - `EMAIL_FROM` = `Fire Force <noreply@fforce.com>` (use an address on your verified domain)
   - `EMAIL_REPLY_TO` = the address replies should go to, e.g. your office inbox (optional)

   Until `EMAIL_FROM` is set, mail goes out from Resend's sandbox sender, which only delivers to your own Resend account email. That is
   handy for a first test. Never commit the key.
4. **Supabase -> Authentication -> URL Configuration:** set *Site URL* to the app's address and add it (and any custom domain) to
   *Redirect URLs*, so the link in the email brings people back to the app.
5. Redeploy `manage-users` after changing secrets or code.

If an invite email fails (for example the key isn't set yet), the account is still created and the Users screen says so; fix the
setting and use the send icon on that person's card to re-send. Untick "Email an invite" to set a temporary password instead.

Emails are built in `supabase/functions/manage-users/index.ts`; `npm test` exercises that function against a fake Resend.

## FireBid Tracker (fire-equipment bids)

**Bids** in the menu (Main Admin, Office Admin and Sales all see it) is a shared board of fire-equipment bid leads for the
42 counties we serve: 26 in Ohio, 11 in Pennsylvania, 5 in West Virginia. Each lead shows the agency, location, equipment and
quantities, NFPA standards and brands, grant funding, due date (urgent ones highlighted), every place it was posted, a shared
status (New / Reviewing / Quoted / Passed) and shared team notes.

**How bids get in**

- **By hand:** *Add / Import* -> enter a bid, or paste / upload JSON. *Sample data* loads eight made-up bids to try things out
  (flagged "Sample", never emailed, removable by office staff).
- **A JSON feed:** *Feed Settings* holds a feed URL (default `/data/fire_equipment_leads.json`, a file inside the app, empty to start).
  *Refresh Feed* and the daily run read it. Any tool that can publish a JSON list of leads can feed the board this way.
- **Pushed by another tool:** `POST {SUPABASE_URL}/functions/v1/bids-daily` with `{"action":"ingest","leads":[...]}` and the
  `x-cron-secret` header (plus the usual `Authorization: Bearer <anon key>`). Use this for a scraper, an alert-email parser or a scheduled agent.

Lead fields: `agency_name`, `state`, `county`, `city`, `solicitation_number`, `due_date` (YYYY-MM-DD), `grant_funded`, `summary`,
`items` [`item_name`, `quantity`, `preferred_brands`, `nfpa_standards`], `sources` [`source`, `url`]. `agency_name` and `state` are required.

**One lead per bid.** Every import goes through the database function `import_bid_leads`, which cleans the data and merges
duplicates: the same solicitation number, or the same agency in the same state with due dates within 3 days and overlapping
equipment. A merge keeps every source link and item, fills in missing fields, and never touches status or notes. Equipment is
sorted into categories (SCBA, Turnout Gear, Extrication, Thermal Imaging, Hose/Nozzles, Rescue Gear, Apparatus, Radios, Other)
from the item names and summary. Bids from outside the 42 counties are hidden by default; a bid with no county yet shows
"County?" and stays visible.

**The daily check** (`.github/workflows/bids-daily.yml`, 7:03 AM Eastern, or run it from the Actions tab) calls the `bids-daily`
Edge Function, which imports the feed and then emails **one digest to everyone with an account** (sent separately, so people
don't see each other's addresses) through Resend: new bids since the last digest, grouped by state, plus open bids due within
7 days. Nothing is sent on days with nothing new. Office staff can also run it from *Feed Settings*, or switch the digest off there.

One-time setup:

1. Apply the `bid_tracker` migration and deploy the `bids-daily` Edge Function (Bolt can do both).
2. Add a function secret `BIDS_CRON_SECRET` (a long random string). Resend secrets are the same ones used for invites.
3. Add four GitHub repository secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public anon key), `BIDS_CRON_SECRET` (same value as step 2)
   and `APP_URL` (the app's address, used for links in the email).
4. Run the workflow once by hand (Actions -> Daily bid check -> Run workflow) and check the result.

### Finding bids automatically

Every morning, before the digest, the `bids-find` Edge Function looks for new bids from four places and posts them to the board.
Office staff manage them in **Bids -> Sources**. Each source simply does nothing until it is set up, and one failing never stops the others.

| Source | What it does | You provide |
| --- | --- | --- |
| **Paste a notice** | *Add / Import -> Paste a notice (AI)*: Claude reads a pasted notice or email and adds any open fire-equipment bid. Works for everyone. | `ANTHROPIC_API_KEY` |
| **Public pages** | Reads the township / city / fire-district bid pages you list, once a day, **only when the page changed** (and respects robots.txt). Claude pulls out any open bids and the document links. | the page addresses (Sources screen) + `ANTHROPIC_API_KEY` |
| **SAM.gov** | New federal notices with a place of performance in OH, PA or WV that mention fire equipment. Few local departments post here. | a free SAM.gov API key as `SAM_API_KEY` |
| **Alert emails** | Alerts from BidNet, state portals and newspaper notice sites are received at an address you set up, queued, and read by Claude the next morning. | inbound email setup (below) + `ANTHROPIC_API_KEY` |

What Claude is and isn't allowed to do: text from pages and emails is treated as untrusted data. Claude only gets a "record bids" form (no
other tools), and everything it returns is checked before saving: bids must be *open* (awards and news are dropped), fire-equipment related,
with a real state, a valid date, and web-only links. Duplicates merge with what is already on the board. Claude can still misread a notice,
so look over what lands on the board.

**Costs and limits.** Pages are only read by Claude when they changed, and emails only when they mention fire-equipment words. There is a hard
cap of 150 AI reads a day (`BIDS_AI_DAILY_CAP` to change it) and 40 per run; anything over waits for the next day. The model defaults to
`claude-haiku-5-5` (`ANTHROPIC_MODEL` to change it).

Setup:

1. Deploy the **`bids-find`** and **`bids-inbound`** Edge Functions. `bids-inbound` must be deployed with *JWT verification off* (an email provider
   can't send a Supabase login; `supabase/config.toml` already says so, so check Bolt/Supabase did not turn it back on).
2. Add function secrets: `ANTHROPIC_API_KEY`, `SAM_API_KEY` (optional), and, for the same cron job as the digest, `BIDS_CRON_SECRET`.
3. **SAM.gov key:** sign in at sam.gov, open *Account Details* and request a public API key. SAM.gov limits requests per day by account type and
   does not publish the numbers, so the app uses as few as it can (usually one a day) and backs off on a rate-limit reply.
4. **Pages:** Bids -> Sources -> add each page (name, address, state, county). Use the page that *lists* the bids. Pages that need JavaScript
   to show anything, and addresses that are only a PDF, can't be read yet; the Sources screen says so for each page.
5. **Alert emails:** pick an address on your domain (for example `bids@fforcesales.com`), subscribe the alert services to it (or forward
   to it), then put the addresses you expect mail from in *Allowed senders* (`bidnet.com, you@example.com`). **Nothing is accepted until you list senders.**
   The inbound receiver supports:
   - **Resend inbound:** add the receiving DNS record Resend asks for, create a webhook for the `email.received` event pointing at
     `https://<your-project>.supabase.co/functions/v1/bids-inbound`, and save its signing secret as `RESEND_WEBHOOK_SECRET`.
   - **Anything else** (Postmark, a forwarding script, Zapier): POST the email as JSON `{from, subject, text}` (or Postmark's format) to the same
     address with the header `x-inbound-secret: <INBOUND_EMAIL_SECRET>`.
6. The scheduled workflow (`.github/workflows/bids-daily.yml`) now runs *find, then digest*. Run it once from the Actions tab and read the results.

Not covered: scraping paid portals (BidNet, OhioBuys and similar generally forbid it; use their alert emails instead), and PDFs or pages that only
render with JavaScript.

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
