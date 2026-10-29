# SIAPP runbook

How to run, deploy and operate SIAPP. For what was built and why, see `docs/BUILD_LOG.md`; for
owner decisions still open, `docs/DECISIONS_PENDING.md`.

## 1. Environment variables

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | all | Postgres. Neon pooled URL in production (`eu-central-1`). Local: `pnpm dev:local` writes the embedded one. |
| `AUTH_SECRET` | all | `openssl rand -base64 32`. Signs sessions, magic links, QR tickets and scanner sessions. Rotating it invalidates all of those. |
| `AUTH_URL` / `APP_URL` | prod + preview | The public origin (`https://siapp.club`). `APP_URL` builds links in emails. |
| `DATA_ENCRYPTION_KEY` | prod | base64, 32 bytes. Encrypts tourist ID photos and producer payout details at rest. **Required in production**; dev derives one from `AUTH_SECRET`. Losing it makes stored ID photos and IBANs unreadable. |
| `STRIPE_SECRET_KEY` | all | `sk_live_…` in prod, `sk_test_…` elsewhere. |
| `STRIPE_WEBHOOK_SECRET` | all | `whsec_…` of the endpoint below. |
| `EMAIL_API_KEY`, `EMAIL_FROM` | prod + preview | Resend key and a verified sender. Without a key emails print to the console (refused in production). |
| `CRON_SECRET` | prod | `openssl rand -base64 32`. Vercel sends it as a bearer token to `/api/cron/*`. |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob for selfies and ID photos; local dev writes `public/uploads/`. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME` | seed | The first ADMIN staff user. |
| `TEST_DATABASE_URL` | CI/tests | Optional Neon branch for `pnpm test`; otherwise embedded Postgres. |

`.env.example` is the authoritative list.

## 2. Local development

```bash
pnpm install
pnpm dev:local          # embedded Postgres :5433 + migrate + seed + next dev :3000
pnpm test               # Vitest on a real Postgres (embedded :5434 or TEST_DATABASE_URL)
pnpm e2e                # Playwright critical path (embedded :5435, next dev :3100) — not while dev runs
pnpm typecheck
```

Sign in with the seeded admin email; the magic link is printed in the terminal (console email
adapter). Staff land in `/admin`, members in `/app`, doors in `/scan`.

## 3. Deploying (Vercel + Neon)

1. Neon project in `eu-central-1`; copy the pooled connection string to `DATABASE_URL`.
2. Vercel project from this repo, region `fra1` (`vercel.json`), all variables from §1.
3. First deploy, then from a machine with the production `DATABASE_URL`:
   ```bash
   pnpm db:deploy        # applies prisma/migrations in order (engine-less, PG 18-safe)
   pnpm db:seed          # city, tiers, plans, packs, settings, the ADMIN from SEED_ADMIN_EMAIL
   pnpm stripe:sync-prices   # creates Stripe Products/Prices and stores the ids (also: /admin/plans → Sync)
   ```
4. Every later schema change: push the migration. `vercel.json` sets `buildCommand` to
   `pnpm db:deploy && pnpm build`, so every Vercel build (preview and production) applies pending
   migrations against its `DATABASE_URL` before compiling. Migrations are additive; never edit an
   applied one. Running `pnpm db:deploy` by hand from a machine with the production URL is still fine
   (idempotent).

### Current deployment (2026-10-29)

- **Vercel**: project `siapp` (id `prj_oJii6I9zA6FXH9VXDxuEP6zEPxiz`, team `marcio-3161s-projects`, Pro),
  git-connected to `github.com/marcio300/siapp` (production branch `main` → auto-deploys on push;
  the first production deploy was created from the build branch by API), Node 22, region `fra1`,
  deployment protection = previews only (production is public). Production URL:
  `https://siapp-two.vercel.app` (`AUTH_URL`/`APP_URL` point there until a custom domain lands).
- **Database**: the Neon org is managed by the Vercel marketplace, so a new Neon *project* needs the
  owner to approve the billing step in Vercel → Storage → Create → Neon. Until then SIAPP runs in a
  separate database `siapp` (own schema, own data) inside the existing EU project `eventos-db-eu`
  (`hidden-fog-56235864`, `eu-central-1`, PG 18, branch `main`, same `neondb_owner` role). It shares
  that project's compute/branch with EventOS — move to a dedicated project before scale, and never
  reset the branch. `DATABASE_URL` is the pooled URL (`…-pooler…/siapp`) on production + preview.
- **Env set on Vercel** (production + preview unless noted): `DATABASE_URL`, `AUTH_SECRET`,
  `DATA_ENCRYPTION_KEY`, `CRON_SECRET` (production), `EMAIL_API_KEY` (Resend key `siapp-production`),
  `EMAIL_PROVIDER=resend`, `EMAIL_FROM="SIAPP <siapp@updates.erasmuslifelisboa.com>"` (the
  Resend-verified EventOS domain — swap for a siapp.club sender once that domain is verified),
  `AUTH_URL`/`APP_URL`, `SEED_ADMIN_EMAIL=marcio@erasmuslifelisboa.com`, `SEED_ADMIN_NAME`,
  `BLOB_READ_WRITE_TOKEN` (Vercel Blob store `siapp-media`, fra1, connected to the project).
  Secrets were generated at deploy time and live only in Vercel (not in the repo).
- **NOT set yet — owner**: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (no Stripe account was
  reachable from the deploy session). Sign-in, onboarding, discovery and free redemptions work without
  them; every checkout and the webhook route fail until they exist. After adding them: register the
  webhook endpoint (see Stripe below) and run `pnpm stripe:sync-prices` (or `/admin/plans` → Sync).
- **Seed**: ran once during the first build (`pnpm db:seed`, create-only upserts) — Lisbon, tiers, plans,
  packs, settings, ADMIN staff + member `marcio@erasmuslifelisboa.com`. Re-run any time; it never
  overwrites edited values.
- **Cloud-session gotcha**: the Claude Code sandbox proxy only relays plain HTTPS (no WebSocket
  upgrade, credentials in headers stripped, no port 5432), so neither `pg`, Neon's serverless driver
  nor its SQL-over-HTTP endpoint can reach the database from there — that is why migrations run in
  the Vercel build. Seeding from a sandbox = temporarily put `&& pnpm db:generate && pnpm db:seed` in
  the project's build command (Vercel dashboard / API), deploy, then remove it.

### Stripe

- Dashboard → Developers → Webhooks → add endpoint `https://<host>/api/webhooks/stripe` with events:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`,
  `charge.succeeded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
- Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and use the printed secret.
- Billing portal: enable it in the dashboard (Settings → Billing → Customer portal) so "Card &
  invoices" works. Tax: enable Stripe Tax as merchant of record for VAT.
- Price changes: edit in `/admin/plans`, then Sync. Stripe prices are immutable — the sync creates a
  new price and archives the old; existing subscribers keep their price until moved by hand.
- The webhook is idempotent (`StripeEvent` table). A 500 means Stripe retries; look in Vercel logs for
  the handler error, fix, and let the retry land or re-send the event from the dashboard.

### Cron

`vercel.json` schedules 12 jobs on `/api/cron/<job>` (registry: `src/lib/cron-jobs.ts`). Vercel adds
`Authorization: Bearer $CRON_SECRET` itself. Each run logs `[cron] <job> <ms> <summary>`. To run one
by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/settle-events`, or
`pnpm jobs:<name>` from a shell with the production `DATABASE_URL`. Jobs are idempotent; re-running
is always safe.

### Neon branches

`TEST_DATABASE_URL` pointed at a Neon branch runs the suite against real Neon (CI does this). The
suite truncates every table — never point it at main. Preview deployments can get their own branch
through the Neon–Vercel integration.

## 4. Operating

### Onboard a producer and an event

1. `/admin/producers` → New producer: name, city, contact email (settlement statements go there),
   payout details (IBAN; stored encrypted, only ADMIN can reveal), default discount %.
2. `/admin/events/new` → producer, title, venue, local start/end (city time). Save → the event is a
   DRAFT and the page shows the **scanner code and a one-time PIN**: write the PIN down and hand both
   to the door (regenerate from the event page if lost).
3. Add offers: free ticket / discounted ticket (face value + discount %) / guest list; capped or
   time-window ("free until 02:00", then pay at door or refuse); private sale tiers + hours before;
   +1 allowed and its cost; cancellation override; per-member max.
4. Publish. Members in that city see it on `/app`. Duplicate (with a day shift) for the next week.

### The door

`/scan` → code + PIN + a door label. Camera or typed code; name search as fallback; "Flag dispute"
on any result. Works offline (cached list, queued scans sync back). The event page's **Door log**
shows every scan. After the event ends the hourly job marks no-shows and finishes the event.

### Handle a fraud flag

`/admin/fraud` lists OPEN flags (device shared by too many accounts, velocity, same card,
self-referral). A flagged redemption is HELD: keys spent, seat taken, no ticket yet.
- **Approve** (OPS+): releases the redemption → ticket issued (or a 24 h payment window for
  discounted ones); all other open flags on that redemption close too.
- **Deny**: keys back, seat offered to the waitlist, flag closed.
- **Ban** (ADMIN): on the member page — sessions killed, open flags denied, held redemptions denied.
Thresholds live in `/admin/settings`.

### Settle a producer

Finished events settle automatically (hourly): `face × (1 − discount%)` per **scanned** discounted
ticket; the producer gets the statement with a CSV. `/admin/settlements` shows what's open; pay by
bank transfer to the payout details, then **Mark paid** with the transfer reference (ADMIN).
Nothing-owed events are auto-marked paid. "Settle finished events now" runs the job on demand.

### Member support

- Member page (`/admin/members/<id>`): wallet pools, ledger, tickets, referrals, devices, flags.
- Keys: ADMIN "Adjust keys" with a reason (ledger row, never a column edit).
- Cancelled event: "Cancel event" on the event page refunds every live redemption (keys + card).
- Account deletion: the member does it in Profile → Delete account; the row is anonymised, ledger kept.
- Partner (ELL) claims: `/admin/partners` — paste the partner's public key, set the promo; contract
  for the issuing side in `docs/PARTNER_TOKEN.md`.

## 5. Checks before opening signups

- `pnpm test` green, `pnpm e2e` green, `pnpm typecheck` clean.
- Production env has `DATA_ENCRYPTION_KEY`, `EMAIL_API_KEY`, `STRIPE_*` live keys, `CRON_SECRET`.
- One real Stripe test purchase through `stripe listen` (subscription, key pack, discounted ticket).
- Legal pages reviewed by counsel (`/legal/*` carry a "draft" banner until then — remove it in
  `src/app/legal/layout.tsx`).
- `docs/DECISIONS_PENDING.md` decided, especially the +1 settlement rule.
- Seed 2–3 weeks of events; door staff trained with a printed name list as fallback.
