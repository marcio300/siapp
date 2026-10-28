# SIAPP Build Log

The running record of what shipped in each phase, the decisions taken along the way, where the code
deviates from the spec and why, and the things that bit us. `CLAUDE.md` carries the dense version for
Claude; this file is the one to read as a human. Newest phase at the bottom.

Legend: **Shipped** — what exists now · **Decisions** — calls made that aren't in the spec ·
**Spec deviations** — where code and spec disagree, deliberately · **Open** — left for a later phase ·
**Gotchas** — things that cost time.

---

## Phase 0 — Scaffold and ported shell (2026-10-28)

**Shipped**

- Next.js 15 App Router + TypeScript strict, pnpm, Tailwind 4, Prisma 6 (engine-less, pg adapter),
  Vercel `fra1`. Structure mirrors EventOS so the two codebases stay familiar.
- Auth: NextAuth email magic link only. The NextAuth user *is* `Member`; `Account`/`Session`/
  `VerificationToken` hang off it. A fresh sign-in creates the member and mints the referral code.
- Staff: `StaffUser` (ADMIN ⊃ OPS ⊃ DOOR) matched to the signed-in member by email. One `/sign-in` for
  everyone; `/` sends staff to `/admin`, members to `/app`.
- Stripe: client + signed webhook route. Every event id is stored in `StripeEvent`; replays are no-ops,
  a failing handler stores the error and lets Stripe retry.
- Email: Resend with console fallback (refused in production), brand base template.
- Backoffice shell: sidebar nav, dashboard, read-only Plans & key packs, read-only Settings, table
  primitives.
- Seed: Lisbon, four tiers, plans × periods + tourist week, two key packs, nine global settings, ADMIN
  staff from `SEED_ADMIN_EMAIL`. Create-only, so edits in the backoffice survive re-seeding.
- `scripts/sync-stripe-prices.ts` pushes plans/packs to Stripe Products + Prices and stores the ids.
- Tests on a real Postgres (embedded by default, Neon branch via `TEST_DATABASE_URL`). CI workflow.
- `pnpm dev:local`: embedded Postgres + migrate + seed + `next dev` in one command.

**Decisions**

- `Member.cityId` is nullable until onboarding (Phase 3): the magic link creates the row before any
  profile data exists. Everything else that must carry a city does.
- FREE only gets a MONTHLY plan (€0). The tourist week hangs off the REGULAR tier with its own
  50-key amount (`Plan.keysPerPeriod`).
- Seed FREE tier at 2 keys/month (spec says 0–2, open item §17).

**Spec deviations**

- Key pack "50 keys / €18" (€0.36/key) breaks the spec's own rule that packs are never cheaper per key
  than REGULAR (€30 / 80 = €0.375). Seeded at €20 (€0.40/key); a test enforces the rule. Final prices are
  a launch-checklist item anyway.

**Open**

- shadcn/ui not installed (no components needed yet). `vercel.json` has no crons (Phase 9).

**Gotchas**

- `embedded-postgres` Linux binaries ship without the `lib*.so.N` symlinks they link against; the helper
  recreates them. Running as root (cloud sandbox) needs the data dirs owned by `postgres`.
- `$queryRaw` on Postgres catalog columns of type `name` fails with the engine-less client — cast to
  text.
- `next build` and `next dev` share `.next`; never run both at once.

---

## Phase 1 — Keys ledger (2026-10-28)

**Shipped**

- `src/domain/keys`: grant plan keys, grant purchased keys, spend (plan first, then purchased, one row
  per pool), refund (mirrors the debit rows, idempotent), expire, admin adjust (reason required),
  balance, ledger with filters. Every write locks the member's `KeyBalance` row and updates the cache in
  the same transaction; ten concurrent spends are tested to serialise correctly.
- Nightly reconcile job (`pnpm jobs:reconcile-balances`): ledger sums vs cache, exit 1 on drift,
  `--fix` rewrites the cache.
- Backoffice: Members list with search, member page with wallet pools panel, filtered ledger and an
  ADMIN-only "Adjust keys" form (writes an `ADMIN_ADJUSTMENT` row with the reason and the staff author).
- Member home shows the ledger-derived wallet.

**Decisions**

- **Expiry is lazy.** The plan pool carries one expiry date. Any ledger write that finds the date in the
  past writes the EXPIRY row first, so a spend after period end can never use stale plan keys, whatever
  the period-end job's timing. The job still runs for the explicit history row.
- A new period's grant extends the pool's expiry to the new date (the previous remainder is expired
  first when a renewal is processed — see Phase 2).
- Refunding plan keys into a period that already ended writes the refund row *and* an EXPIRY row, so the
  history is explicit and the keys are never resurrected.
- Grants are idempotent by `reference` (unique per type). Webhooks pass the Stripe id so a redelivery can
  never double-grant.
- Plan-pool admin credits require an active period (they expire with it); otherwise grant purchased
  keys.

**Open**

- Partial refunds: the row shape supports a smaller mirror; not built (spec says not yet).

---

## Phase 2 — Membership and billing (2026-10-28)

**Shipped**

- `src/domain/billing`: Stripe Checkout for subscriptions (any recurring Plan/PlanPrice), key packs
  (one-off) and the tourist pass (one-off → a 7-day `TOURIST_WEEK` subscription with no Stripe
  subscription). Plan change with Stripe proration, cancel/resume renewal (`cancelAtPeriodEnd`),
  billing-portal link. Nothing is fulfilled on the redirect back — only the signed webhook grants keys.
- Webhooks: `checkout.session.completed` (+ async success) links subscriptions / grants packs /
  activates the tourist pass; `invoice.paid` (`subscription_create`, `subscription_cycle`) mirrors the
  period and grants keys; `invoice.payment_failed` → PAST_DUE; `customer.subscription.updated`
  mirrors plan/status/cancel flag/period; `customer.subscription.deleted` ends the paid membership and
  puts the member back on FREE. Events are read tolerantly across Stripe API versions (classic and
  2025+ shapes) and work in any delivery order.
- FREE tier is a real subscription row (no Stripe id), created on the member's first sign-in and again
  whenever a paid membership ends. It grants the FREE tier's keys monthly like everything else.
- Jobs: `pnpm jobs:monthly-grants` (daily — monthly grants for quarterly/yearly plans and FREE, via
  `nextGrantAt`) and `pnpm jobs:expire-periods` (hourly — expires plan keys for ended periods, ends
  tourist passes). Both accept a member filter for targeted re-runs.
- Member app: Membership screen (current plan, keys per month, renewal/expiry date, cancel/resume,
  card & invoices, pick/change plan grid, tourist pass card), Wallet screen (pools, buy packs, history),
  return page after Stripe, header nav. Backoffice: Plans & key packs now editable by ADMIN (tier keys,
  plan prices, tourist keys, pack keys/price/on-sale) with a "Sync to Stripe" button; member page shows
  a membership card.
- Tests: 13 billing checks (43 total) with a fake Stripe surface and synthetic webhook events — FREE
  bootstrap and monthly roll, FREE cannot buy packs, checkout session shapes, activation + replay no-op
  (invariant 11), out-of-order delivery, renewal expiry, past-due/cancel/deleted lifecycle, quarterly
  monthly cadence, plan change with no early grant, packs, tourist pass lifecycle.

**Decisions**

- **Keys for a new tier apply from the next grant**, never at the moment of an upgrade (spec §3). The
  prorated `subscription_update` invoice is deliberately ignored for grants. Shown as copy on the
  Membership screen.
- **A renewal expires the previous period's remainder first** (use it or lose it), then grants.
- Quarterly/yearly: first month granted on the paid invoice, the following months by the daily job on
  each monthly anniversary, each expiring at the next anniversary (last one at period end).
- When Stripe ends a subscription early (dunning), the paid keys expire immediately and FREE resumes.
- Tourist pass never sets `firstPaidAt` (it doesn't count for referral vesting, spec §9) but counts as
  paid for buying packs.
- Stripe Customer is created on the member's first purchase and reused for life.
- Price edits in the backoffice affect new purchases only; the sync rotates immutable Stripe prices
  (new price + archive old). Moving existing subscribers to a new price is not built.
- Without a Stripe key, member purchase buttons fail with a generic "payments aren't available"
  notice (the real cause is logged); the backoffice sync shows the exact config error.

**Spec deviations**

- None. One spec item deferred: the tourist pass's "ID photo required at purchase" gate waits for the
  upload flow (Phase 3) — marked as a TODO in `startTouristPassCheckout`.

**Open**

- Emails for grants, failed payments and tourist-pass expiry (Phase 9). Cron wiring in `vercel.json`
  (Phase 9). Live Stripe verification: everything was tested with synthetic events; run
  `stripe listen` + one test purchase before launch. Moving existing subscribers when a price changes.

**Gotchas**

- Stripe SDK 22 targets API `2026-08-26`: period dates live on subscription *items*, the invoice's
  subscription id under `parent.subscription_details`, the line's price under
  `pricing.price_details.price`. The handlers accept both old and new shapes.
- Tests that run the grant/expiry jobs must pass `memberId`, or they sweep every member in the shared
  test database.
