# SIAPP — "Sorry, it's a private party"

Membership club for nightlife and events in Lisbon. Members pay a subscription, receive **keys** and
spend them on free or discounted entry to partner events. Spinoff of EventOS, built as a separate
codebase on the same stack (Next.js App Router · Prisma on Neon Postgres · NextAuth · Stripe ·
Tailwind · Resend · Vitest).

Start with `CLAUDE.md`, then `docs/PRODUCT_SPEC.md`, `docs/DATA_MODEL.md`, `docs/BUILD_PLAN.md`,
`docs/BRAND.md`. Build phase by phase as laid out in the build plan.

## Getting started

```bash
pnpm install
pnpm dev:local
```

`dev:local` boots an embedded Postgres on port 5433 (data in `.devdb/`, nothing to install), creates
`.env` from `.env.example` on first run (random `AUTH_SECRET`), applies the migrations, seeds, and
starts `next dev`. Re-runs are fast and idempotent; `pnpm dev:local -- --reset` wipes the local DB.

Plain `pnpm dev` works too once `.env` has a reachable `DATABASE_URL` (embedded or a Neon branch):

```bash
pnpm db:deploy   # apply prisma/migrations/* (engine-less, works on PG 18)
pnpm db:seed     # city Lisbon, tiers, plans, key packs, settings, ADMIN staff from SEED_ADMIN_EMAIL
pnpm dev
```

Sign in at `/sign-in` with `SEED_ADMIN_EMAIL`. Without `EMAIL_API_KEY` the magic link is printed to
the dev server console. Staff land on `/admin`, members on `/app`.

### Environment

See `.env.example` — every variable is documented there. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (Neon pooled URL in prod, `eu-central-1`) |
| `AUTH_SECRET` | NextAuth secret (`openssl rand -base64 32`) |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Resend. Unset = console email (refused in production) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe; the webhook secret comes from `stripe listen` or the dashboard endpoint |
| `SEED_ADMIN_EMAIL` | The one ADMIN staff user created by the seed |
| `TEST_DATABASE_URL` | Optional: run the test suite against this database instead of the embedded one |

## Testing

```bash
pnpm test          # vitest run
pnpm test:watch
```

Tests run against a **real Postgres** — the ledger and allocation invariants in `docs/DATA_MODEL.md`
can't be proven against mocks. `tests/global-setup.ts` provides the database:

- **Default:** an embedded Postgres on port 5434 (data in `.testdb/`), migrations applied via
  `scripts/db-deploy.ts`. Zero configuration.
- **Neon branch:** set `TEST_DATABASE_URL` (in `.env` or the shell) to a branch's connection string and
  the suite uses it instead. Create one with `neonctl branches create --name test` (or the Neon
  console → Branches → New branch from `main`), copy its pooled URL, and run `pnpm test`. The suite
  **truncates every table** between files, so give it a dedicated branch — never `main`.

CI (`.github/workflows/ci.yml`) runs typecheck, migrations + seed, the suite and a production build
against a Postgres service container.

## Stripe prices

Plans, plan prices and key packs live in the database (`Plan`, `PlanPrice`, `KeyPack`). After editing
amounts (seed or backoffice), push them to Stripe:

```bash
pnpm stripe:sync-prices             # creates/updates Products + Prices, stores the ids back
pnpm stripe:sync-prices -- --dry-run
```

Stripe prices are immutable: a changed amount creates a new Price and archives the old one. €0 plans
(FREE) get no Stripe objects. Register the webhook at `{APP_URL}/api/webhooks/stripe`; locally use
`stripe listen --forward-to localhost:3000/api/webhooks/stripe`. Every delivery is recorded in
`StripeEvent` and replays are no-ops (`src/lib/stripe-webhook.ts`).

## Layout

```
prisma/            schema, migrations, seed (seed-data.ts is importable by tests)
scripts/           db-deploy, dev-local, embedded-pg helper, sync-stripe-prices
src/app/           App Router: /sign-in, /app (member), /admin (backoffice), /api/auth, /api/webhooks/stripe
src/lib/           db, auth (+ auth-adapter), authz guard, email (+ templates), stripe, stripe-webhook, settings
src/components/    wordmark, key icon, backoffice primitives (table, badge, stat card, page header)
src/domain/        business rules by module (Phase 1+)
tests/             Vitest suite + global DB setup
```

## Phase status

- **Phase 0 — done**: scaffold, auth (email magic link on `Member`), Prisma singleton, Stripe client +
  idempotent webhook, email base template, backoffice shell (dashboard, plans & packs, settings —
  read-only), seed, Stripe price sync, Vitest on real Postgres, CI.
- Next: **Phase 1 — keys ledger** (`src/domain/keys`), see `docs/BUILD_PLAN.md`.
