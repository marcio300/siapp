# SIAPP — "Sorry, it's a private party"

Membership club for nightlife and events in Lisbon (more cities later). Members pay a subscription,
receive **keys** (the credit unit) and spend keys on free or discounted entry to partner events.
This repo is a spinoff of EventOS, built as a **new, separate codebase** with the same stack.

Read these before touching anything:

- `docs/PRODUCT_SPEC.md` — the agreed product rules. If code and spec disagree, the spec wins; raise it.
- `docs/DATA_MODEL.md` — entities, ledger design and invariants. `prisma/schema.prisma` is the draft.
- `docs/BUILD_PLAN.md` — phased plan with acceptance criteria. Work phase by phase, in order.
- `docs/BRAND.md` — colours, type and UI vocabulary.

## Stack (mirror EventOS exactly)

- Next.js (App Router, TypeScript strict) on Vercel, region `fra1`
- Prisma on Neon Postgres (`eu-central-1`)
- NextAuth (email magic-link / email+password; **no SMS**)
- Stripe (Billing for subscriptions, Checkout/PaymentIntents for key packs and discounted tickets)
- Tailwind + shadcn/ui
- Resend (or whatever EventOS uses) for transactional email
- Vitest for unit tests, Playwright for the few critical e2e flows

The EventOS repo is cloned alongside this one at `../eventos`. **Read it before writing a module that
EventOS already has** (auth, ticket issuance, QR generation, scanner, Stripe webhooks, email templates,
backoffice shell) and port the code rather than re-inventing it. Do not import from it at runtime; copy
and adapt. Keep the same folder layout and naming conventions as EventOS so the two codebases stay
familiar.

## Domain glossary (use these names in code, DB and UI)

| Term | Meaning |
|---|---|
| **Member** | A user with an account. Every user is a member; the free tier is still a membership. |
| **Tier** | Subscription level: `FREE`, `SOCIAL`, `REGULAR`, `PLUS`. Config lives in DB, not code. |
| **Plan** | A tier × billing period (monthly / quarterly / yearly) or the `TOURIST_WEEK` pass. Maps to a Stripe Price. |
| **Key** | The credit unit. Symbol: key icon. Never say "credits" in UI copy; say keys. |
| **Plan keys** | Keys granted by the subscription each period. **Expire at period end.** Spent first. |
| **Purchased keys** | Keys bought in packs. **Never expire.** Spent after plan keys. |
| **Producer** | A partner (club, promoter, festival). Has no login at launch. |
| **Event** | A night/show by a producer. Belongs to a City. |
| **Offer** | What members can redeem on an event: free ticket, discounted ticket or guest list. One event has 1..n offers. |
| **Allocation** | An offer's capacity: a numeric cap, or a time window (guest list "free until 02:00"). |
| **Private sale** | Per-offer early-access window for selected tiers before the offer opens to all. |
| **Redemption** | A member spending keys on an offer. Produces a Ticket. |
| **Ticket** | The scannable QR (same format and scanner as EventOS). Carries the member's photo and optional +1. |
| **Settlement** | What we owe a producer for discounted-ticket money we collected on their behalf. |
| **Backoffice** | Our internal admin. Staff only. |
| **Scanner** | Door web app. Producers get a per-event scanner login only. |
| **ELL** | Erasmus Life Lisboa. Members of ELL can claim a promo membership via a signed token from EventOS. |

## Non-negotiable rules (the ones that are easy to get subtly wrong)

1. **Keys are a ledger, never a column.** A member's balance is the sum of `KeyTransaction` rows.
   Never `UPDATE balance = balance - x`. Every grant, spend, refund, expiry and referral bonus is a row.
2. **Spend order:** plan keys (expiring) first, then purchased keys. Expiry runs per billing period.
3. **Allocation is enforced in a transaction** with a row lock on the offer (`SELECT ... FOR UPDATE`).
   Never check-then-write capacity across two queries.
4. **Cancellation window is 24h before event start.** Inside the window, redemption is final and
   no-shows forfeit keys. Partial refunds and grace periods are **not built yet** — but the ledger must
   allow a partial refund row later. Don't design cancellation as boolean.
5. **Referral bonus (10 keys each) vests only after** the invitee's first paid period is past the Stripe
   refund window **and** the invitee has at least one scanned ticket. Never pay out at checkout.
6. **Discounts are a simple percentage off face value.** We collect the money; the producer is settled
   `face × (1 − discount%)` per **scanned** ticket, not per redeemed ticket.
7. **One account per email, email verification required, disposable domains blocked, age ≥ 24 attested
   at signup.** Selfie is mandatory before the first redemption and is shown on every scanned ticket.
8. **+1 guests have no account.** They are a name on the member's ticket, scanned together. Whether +1
   is allowed and what it costs is per offer.
9. **Multi-city from day one.** Every event, producer, plan price and member home base carries `cityId`.
   Lisbon is the only seeded city. No city-specific logic in code.
10. **Producers have no portal.** They get a scanner login per event and a settlement email. Do not
    build producer self-service; it will come from the future EventOS clone.
11. **All money in integer cents, all times in UTC, display in `Europe/Lisbon`** (city timezone field).
12. Webhooks (Stripe) are idempotent: store the event id, skip duplicates, never trust the client for
    payment state.

## Conventions

- Server Actions or route handlers for mutations; every mutation validated with zod.
- Business rules live in `src/domain/*` (pure functions + Prisma repos), not in components.
  `src/domain/keys`, `src/domain/redemption`, `src/domain/billing`, `src/domain/referrals`,
  `src/domain/fraud`, `src/domain/settlement`.
- Tests for every invariant in "Non-negotiable rules" before marking a phase done.
- Feature flags via a `Setting` table (global defaults) — e.g. `cancellation_window_hours = 24`.
- Copy is English-first; i18n-ready (next-intl) with `pt` as the second locale, but don't translate yet.
- Commit small, conventional commits. Each phase in `docs/BUILD_PLAN.md` ends with a green test run.

## Out of scope for now (do not build, but keep the model ready)

Producer portal, native apps, partial cancellation refunds, grace period after redemption, reputation
score effects on access (we only *record* attendance/no-shows), cities beyond Lisbon, SMS.

## Build progress (keep updated as phases land)

- **Done — Phase 0 (scaffold + ported shell)**: pnpm project (`node-linker=hoisted` in `.npmrc` so the
  engine-less Prisma client lands at `node_modules/.prisma/client`, which `next.config.ts` traces into
  Vercel functions exactly like EventOS). Ported from EventOS: tooling config, Prisma singleton
  (`src/lib/db.ts`, engineType `client` + `@prisma/adapter-pg`), NextAuth email magic link ONLY with the
  Prisma adapter pointed at `Member` (`src/lib/auth-adapter.ts` maps `user`→`member`, overrides
  createUser to mint `referralCode`; `Account`/`Session`/`VerificationToken` hang off Member), backoffice
  guard (`src/lib/authz.ts`: `requireStaffPage/requireStaff(minRole)` with ADMIN ⊃ OPS ⊃ DOOR resolved
  from `StaffUser` by email; test seam `TEST_STAFF_EMAIL`), Stripe client (`src/lib/stripe.ts`) + webhook
  route with signature check and `StripeEvent` idempotency (`src/lib/stripe-webhook.ts`: create row →
  `processedAt` set = replay no-op; handler error stored + rethrown → 500 → Stripe retries → handler
  re-runs; `registerStripeHandler(type, fn)` is where Phase 2 plugs billing in), Resend email with console
  fallback (`src/lib/email.ts`) + brand base template (`src/lib/email/template.ts` `renderEmail`), admin
  shell (`/admin` layout/nav + dashboard, read-only Plans & key packs, read-only Settings) with table
  primitives in `src/components/backoffice/`. One `/sign-in` for everyone; `/` routes staff → `/admin`,
  members → `/app` (placeholder wallet). Seed (`prisma/seed-data.ts` `runSeed`, CLI `prisma/seed.ts`):
  Lisbon, 4 tiers (FREE 2 / SOCIAL 30 / REGULAR 80 / PLUS 150 keys), FREE×MONTHLY (€0) + 3 paid tiers ×
  monthly/quarterly(−10%)/yearly(10×) + TOURIST_WEEK (on REGULAR, `Plan.keysPerPeriod=50`, €25), packs
  20/€8 + 50/€20, the 9 DATA_MODEL settings, ADMIN staff + Member from `SEED_ADMIN_EMAIL`; create-only
  upserts so edits survive re-runs. `scripts/sync-stripe-prices.ts` (Products/Prices from Plan/PlanPrice/
  KeyPack, immutable-price rotation + archive, idempotency keys, `--dry-run`). Vitest on a REAL Postgres
  (`tests/global-setup.ts`: `TEST_DATABASE_URL` e.g. a Neon branch, else embedded PG on 5434) — 16 checks:
  seed + idempotency, webhook replay/retry/signature (invariant 11), Stripe sync, adapter magic-link
  round trip, email template. `pnpm dev:local` = embedded PG on 5433 + migrate + seed + next dev.
  Migrations: `prisma/migrations/0_init` applied by engine-less `scripts/db-deploy.ts` (PG 18-safe).
- **Done — Phase 1 (keys ledger)**: `src/domain/keys/` — `ledger.ts` (`grantPlanKeys(memberId, amount,
  expiresAt, ref)`, `grantPurchasedKeys(memberId, amount, type, ref)`, `spendKeys` → `{fromPlan,
  fromPurchased}` PLAN first then PURCHASED with one row per pool touched, `refundKeys(redemptionId)` mirrors
  the REDEMPTION rows as CANCELLATION_REFUND (idempotent; a partial refund later = a smaller mirror),
  `expirePlanKeys(memberId, periodEnd)` EXPIRY row for the remainder, `adjustKeys` ADMIN_ADJUSTMENT with
  mandatory reason + `createdById`, `getBalance` (effective: expired plan pool reads 0), `getLedger` with
  pool/type/date filters), `reconcile.ts` (`reconcileBalances({fix})` ledger sums vs `KeyBalance` cache),
  `errors.ts` (`KeysError`, `InsufficientKeysError`). EVERY write runs in one interactive tx that upserts +
  `SELECT … FOR UPDATE`s the member's `KeyBalance` row (serialises concurrent spends — invariant 1 is
  tested with 10 parallel spends), writes the ledger row(s), then updates the cache. Plan pool has ONE
  expiry date (`KeyBalance.planKeysExpireAt`); a later grant extends it; **expiry is lazy** — any write
  that finds the date in the past writes the EXPIRY row first, so a spend after period end can never use
  stale plan keys regardless of job timing; `refundKeys` into an ended period writes the refund AND an
  EXPIRY row. Grants are idempotent by `ref.reference` (`KeyTransaction.reference`, unique per `type` —
  migration `20261028120000_keys_ledger_reference`) — Phase 2 webhooks should pass e.g. `pack:{sessionId}`
  / `sub:{subId}:{period}`. Job `scripts/jobs/reconcile-balances.ts` (`pnpm jobs:reconcile-balances`,
  `--fix` rewrites the cache; exit 1 on mismatch). Backoffice: `/admin/members` (search email/name/
  referral code, OPS+) → `/admin/members/[id]` (wallet pools panel `src/components/backoffice/
  wallet-pools.tsx`, ledger table w/ pool + type filters, ADMIN-only "Adjust keys" form → server action
  `[id]/actions.ts` zod + `requireStaff("ADMIN")`, errors/success via `?error=`/`?adjusted=`). `/app`
  wallet now reads `getBalance`. Tests `tests/keys.test.ts` (14; `tests/fixtures.ts` builds the
  city→producer→event→offer→redemption chain so rows can reference a redemption): invariants 1 (incl.
  concurrency), 2, 4, cross-pool two rows, cross-pool refund, refund idempotency, refund-into-ended-period
  expiry, lazy expiry, grant extension, reference idempotency, adjustments, filters, reconcile drift+fix.
  Suite = 30 checks.
- **Done — Phase 2 (membership + billing)**: `src/domain/billing/` — `subscriptions.ts` (`getMembership`
  → `{subscription, tierCode, isPaid, isTourist, isRecurring, canBuyPacks, keysPerMonth}`;
  `ensureFreeSubscription` = FREE row w/o Stripe id, created in the auth adapter's createUser (try/catch,
  never breaks sign-in) and whenever a paid sub ends; `applyPaidPeriod` (invoice.paid: expire previous
  remainder if renewal → upsert row by `stripeSubscriptionId` → supersede local FREE/tourist rows →
  grant first month, ref `sub:{rowId}:{periodStartISO}`; monthly: expiresAt=periodEnd, nextGrantAt null;
  quarterly/yearly: expiresAt=+1mo, nextGrantAt=+1mo); `linkStripeSubscription` (session.completed
  before/after invoice — any order), `activateTouristPass` (7d, no Stripe sub, idempotent on
  `Subscription.checkoutSessionId` — migration `20261028150000_billing_checkout_session`, firstPaidAt stays
  null), `markPastDue`, `mirrorStripeSubscription` (plan via PlanPrice.stripePriceId, cancel flag,
  status, period), `endStripeSubscription` (CANCELLED + expire keys NOW via `expirePlanKeys(memberId,
  sub.currentPeriodEnd)` + ensureFree), jobs `runMonthlyGrants({now, memberId?})` (nextGrantAt ≤ now,
  ACTIVE only; FREE rolls its own month) + `runExpirePeriods` (keys for ended periods, tourist →
  EXPIRED + FREE)); `checkout.ts` (`ensureStripeCustomer` idempotency `customer_{memberId}`,
  `startSubscriptionCheckout` mode subscription w/ `metadata.kind="subscription"` + `subscription_data.
  metadata {memberId, planId}`, `startKeyPackCheckout` (refuses FREE: `canBuyPacks`), `startTouristPassCheckout`
  (refuses when already paid; TODO Phase 3 ID-photo gate), `changeSubscriptionPlan` (retrieve item →
  update price w/ create_prorations; optimistic planId mirror; NO grant), `setCancelAtPeriodEnd`,
  `createPortalSession`); `webhooks.ts` `registerBillingWebhooks()` (called at module top of the webhook
  route; tolerant extractors `invoiceSubscriptionId`/`invoiceLines`/`subscriptionPeriod` for classic +
  2025 shapes; invoice.paid ONLY for subscription_create|subscription_cycle — subscription_update never
  grants); `stripe-client.ts` `BillingStripe` subset + `setBillingStripeForTests`; `stripe-prices.ts`
  (sync core moved here; `scripts/sync-stripe-prices.ts` is the CLI, `/admin/plans` "Sync to Stripe" the
  button); `periods.ts` (`addMonths` clamps, `monthlyGrantWindow`). Jobs `pnpm jobs:monthly-grants`
  (daily) / `pnpm jobs:expire-periods` (hourly). Member app: `/app/membership` (+ `actions.ts`:
  choosePlan subscribe|change, cancel/resume, tourist, portal — BillingError → `?error=`, anything else →
  generic notice + console.error), `/app/wallet` (+ buyPack), `/app/billing/return`, `src/components/
  member-nav.tsx` `MemberHeader`/`Notice`; `requireMember()` in authz for actions. Backoffice `/admin/plans`
  ADMIN inline edits (tier keys, plan € + tourist keys, pack keys/€/on-sale) + sync action; member page
  membership card. Tests `tests/billing.test.ts` (13 → suite 43): fake Stripe + synthetic events.
- **Done — Phase 3 (identity, onboarding, fraud foundation)**: `src/domain/identity/` — `onboarding.ts`
  (`OnboardingSchema` zod, `ageAt`, `MIN_AGE=24`, `completeOnboarding(memberId, input)` → sets name/DOB/
  `ageAttestedAt`/`cityId`/`onboardedAt`, records `Referral(PENDING)` by code (results `recorded|
  unknown_code|self|already_referred`), stores `Member.partnerClaimToken` (JWT-shape check only — Phase 7
  verifies)), `verification.ts` (`verificationStatus(member)` → emailVerified/onboarded/selfie/banned/
  `canRedeem`/`nextStep` — Phase 5's eligibility step 1), `photos.ts` (`storeSelfie`, `storeIdPhoto` =
  AES-256-GCM via `src/lib/media/crypto.ts` (`ID_PHOTO_KEY` base64 32B, dev derives from AUTH_SECRET),
  `readIdPhoto`, `deleteIdPhoto`, `purgeIdPhotos` 30d); `src/lib/media/storage.ts` ported from EventOS
  (+ `get`, `makeMemoryStorage`, `setMediaStorageForTests`). `src/domain/fraud/` — `disposable.ts`
  (`isDisposableEmail`, vendored `disposable-domains.json` ~10k, subdomain match; refresh `pnpm
  fraud:update-disposable-domains`; enforced in auth `signIn` callback + friendly check in the sign-in
  action), `devices.ts` (`recordDevice` upsert + DEVICE_MAX_ACCOUNTS flag when accounts > setting;
  `deviceOverlap`), `evaluate.ts` (`evaluate(memberId, offerId, {db?, now?, redemptionId?})` → `{decision,
  fired}`; rules DEVICE_MAX_ACCOUNTS / VELOCITY_FIRST_HOUR (<1h, live redemptions ≥ setting) /
  VELOCITY_PRIVATE_SALE (<24h, setting `velocity_private_sale_first_day_max`) / OVERLAP (live redemption,
  other event, ±`overlap_tolerance_hours`) / SAME_CARD (`PaymentMethodFingerprint` shared > `same_card_max_
  accounts`); writes OPEN flags via `flags.ts` `openFlag` (one per member+rule+redemption, evidence updated)),
  `cards.ts` (`charge.succeeded` → `recordCardFingerprint`; `registerFraudWebhooks()` in the route),
  `review.ts` (`reviewFlag` APPROVED releases HELD→ACTIVE only when no other OPEN flag on the redemption,
  DENIED → HELD→DENIED; `banMember` = bannedAt+reason, open flags DENIED, HELD denied, sessions deleted;
  `unbanMember`). Schema: `Member.onboardedAt/partnerClaimToken/partnerClaimTokenAt/banReason`,
  `PaymentMethodFingerprint` — migration `20261028180000_identity_fraud`. Billing: tourist checkout now
  requires `idPhotoUploadedAt`. Member app: `/r/[code]` route handler (cookie `siapp_ref` 30d),
  `/app/onboarding` (+actions), `/app/profile` (selfie `capture="user"`, ID photo, delete), `src/app/app/
  layout.tsx` mounts `DeviceFingerprint` (client, FingerprintJS v5 MIT, once per tab via sessionStorage →
  `recordDeviceAction`), `requireOnboardedMember(next)` in authz gates /app, /app/wallet, /app/membership,
  /app/profile. Backoffice: `/admin/fraud` (+actions `reviewFlagAction` OPS, `banMemberAction`/`unban` ADMIN),
  member page identity/ID-photo/attendance/account cards + flags + devices tables, `/api/admin/id-photo/
  [memberId]` (OPS+, decrypts, no-store). Jobs `pnpm jobs:purge-id-photos`. Tests `tests/identity.test.ts`
  (7) + `tests/fraud.test.ts` (7) → suite 57.
- **Phase 0 decisions to know**: `Member.cityId` is nullable until onboarding (Phase 3) — the magic link
  creates the row before any profile exists. Spec's "50 keys / €18" placeholder broke the spec's own
  "packs never cheaper per key than REGULAR" rule, so it's seeded at €20 (test enforces the rule). FREE
  only gets a MONTHLY plan. shadcn/ui not installed yet (no components needed; add when the member app
  starts). `vercel.json` has no crons yet (Phase 9).
- **Gotchas**: embedded-postgres' Linux tarball lacks the `lib*.so.N` symlinks its binaries need —
  `scripts/embedded-pg.ts` recreates them on start. When running as root (cloud sandboxes) the data dirs
  must be owned by the `postgres` user: `mkdir -p .devdb .testdb && chown postgres .devdb .testdb`.
  `$queryRaw` on catalog columns of type `name` fails with the engine-less client — cast to `::text`.
  `next build` and `next dev` share `.next`; never run both at once. Don't `pkill -f "next dev"` from a
  shell whose own command line contains that string.
