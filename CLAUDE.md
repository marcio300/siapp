# SIAPP — "Sorry, it's a private party"

Membership club for nightlife and events in Lisbon (more cities later). Members pay a subscription,
receive **keys** (the credit unit) and spend keys on free or discounted entry to partner events.
This repo is a spinoff of EventOS, built as a **new, separate codebase** with the same stack.

Read these before touching anything:

- `docs/PRODUCT_SPEC.md` — the agreed product rules. If code and spec disagree, the spec wins; raise it.
- `docs/DATA_MODEL.md` — entities, ledger design and invariants. `prisma/schema.prisma` is the draft.
- `docs/BUILD_PLAN.md` — phased plan with acceptance criteria. Work phase by phase, in order.
- `docs/BRAND.md` — colours, type and UI vocabulary.
- `docs/EVENTOS_INTEGRATION.md` — SIAPP as a sales channel of EventOS (decided 2026-11-08; contract =
  EventOS `docs/SIAPP_API.md`; build = Phases 11–13 in `docs/BUILD_PLAN.md`).

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
6. **Discounts are a simple percentage off face value (10–99 %).** For hand-managed producers we
   collect the money and settle `face × (1 − discount%)` per **scanned** ticket, not per redeemed
   ticket. For producers on EventOS the member pays the producer through EventOS checkout
   (`Offer.paymentMode = PRODUCER_COLLECTS`) and nothing is settled — see `docs/EVENTOS_INTEGRATION.md`.
7. **One account per email, email verification required, disposable domains blocked, age ≥ 24 attested
   at signup.** Selfie is mandatory before the first redemption and is shown on every scanned ticket.
8. **+1 guests have no account.** They are a name on the member's ticket, scanned together. Whether +1
   is allowed and what it costs is per offer.
9. **Multi-city from day one.** Every event, producer, plan price and member home base carries `cityId`.
   Lisbon is the only seeded city. No city-specific logic in code.
10. **Producers have no SIAPP portal.** Hand-managed producers get a scanner login per event and a
    settlement email. Producers on EventOS manage their SIAPP presence from EventOS (the SIAPP tab) and
    scan with the EventOS scanner — that is the portal; never build producer self-service in SIAPP.
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
  `deviceOverlap`), `evaluate.ts` (`evaluate(memberId, offerId, {db?, now?, redemptionId?})` → `{decision ALLOW|REVIEW|
  REJECT, fired, rejected}`; OVERLAP (live redemption, other event, ±`overlap_tolerance_hours`) is a HARD
  REJECT with no flag (owner decision); review rules DEVICE_MAX_ACCOUNTS / VELOCITY_FIRST_HOUR (<1h, live
  redemptions ≥ setting) / VELOCITY_PRIVATE_SALE (<24h, setting `velocity_private_sale_first_day_max`) / SAME_CARD (`PaymentMethodFingerprint` shared > `same_card_max_
  accounts`); writes OPEN flags via `flags.ts` `openFlag` (one per member+rule+redemption, evidence updated)),
  `cards.ts` (`charge.succeeded` → `recordCardFingerprint`; `registerFraudWebhooks()` in the route),
  `review.ts` (`reviewFlag` APPROVED releases HELD→ACTIVE and closes the redemption's other OPEN flags as
  APPROVED (owner: one approval releases everything), DENIED → HELD→DENIED; `banMember` = bannedAt+reason, open flags DENIED, HELD denied, sessions deleted;
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
- **Done — Phase 4 (producers, events, offers — backoffice)**: `src/lib/time.ts` (`tzOffsetMs`, `localToUtc`
  samples offsets at ±12 h and picks the earliest valid candidate — overlap → first occurrence, gap →
  after the jump; `utcToLocal`; `windowUntilFromLocalTime(eventStartsAt, "02:00", tz)` = next 02:00 after
  start). `src/lib/media/crypto.ts` gained `encryptText/decryptText`; key env is now `DATA_ENCRYPTION_KEY`
  (`ID_PHOTO_KEY` accepted). `src/domain/producers/` (`ProducerSchema`, `createProducer`/`updateProducer`
  (empty payout keeps stored; city change refused with events), `clearPayoutDetails`, `payoutDetails(enc,
  reveal)` masked/full). `src/domain/events/` — `schemas.ts` (`EventSchema` w/ local `{date,time}` pairs,
  `OfferSchema` superRefine per type/allocation/private sale, `optionalInt` preprocess, consts
  `TIER_CODES/OFFER_TYPES/ALLOCATION_TYPES/AFTER_WINDOW/PRIVATE_SALE_HOURS`), `events.ts` (`createEvent` →
  `{event, pin}` (cityId from producer, `scannerCode` 6 chars, `scannerPinHash` scrypt; `verifyPin`,
  `authenticateScanner(code, pin)` for Phase 6, `regenerateScannerPin`), `updateEvent` (frozen when
  FINISHED/CANCELLED), `setEventStatus` (TRANSITIONS map; PUBLISHED needs ≥1 offer; `publishedAt` stamped
  once; fills `privateSaleOpensAt = publishedAt + hoursBefore` where unset), `duplicateEvent({shiftDays})`
  (offers cloned, opens-at reset, new creds), `offerCounters(ids)` → redeemed (PENDING_PAYMENT/HELD/ACTIVE/
  CHECKED_IN) + checkedIn, `eventFormDefaults`), `offers.ts` (`addOffer`/`updateOffer`/`deleteOffer`;
  `validUntil` absolute UTC via windowUntil; explicit opens-at wins, else computed when already published;
  after live redemptions type/keyCost/price frozen + capacity ≥ redeemed; delete needs 0 redemptions;
  `offerFormDefaults`). UI: `/admin/producers` (+`[id]`, reveal/clear ADMIN), `/admin/events` (filters
  city/status/from/to/past, counters), `/admin/events/new`, `/admin/events/[id]` (status buttons, duplicate
  w/ shift, scanner card + one-time `?pin=` banner, offers as `<details>` w/ edit form + add form);
  `src/lib/forms.ts` FormData helpers; actions in `src/app/admin/events/actions.ts` (query-before-hash
  `fail`). Tests `tests/time.test.ts` (6) + `tests/events.test.ts` (5) → suite 68.
- **Done — Phase 5 (member app: discovery + redemption)**: `src/domain/redemption/` — `errors.ts`
  (`RedemptionError{reason, detail}`, `RefusalReason` union), `eligibility.ts` (`checkEligibility(input)` pure
  — order: banned/verified → event PUBLISHED + redeemFrom/Until → FREE needs `openToFree` → private sale
  (`privateSaleOpensAt` null = never opens) → +1 allowed → capacity (SOLD_OUT; `WAITLIST_ONLY` when live
  claims of others reserve the rest) → maxPerMember → keys; `offerCost(offer, plusOne)` → `{keyCost,
  cashCents}` with `discountedPriceCents` round; `explainEligibility` for pages; `reservedSeats`;
  `cancellationWindowHours(offer, db)`; `COUNTING` statuses), `tickets.ts` (`newQrPayload` 32 hex like
  EventOS's opaque token, `signQrPayload` HMAC(AUTH_SECRET) base64url stored in `Ticket.signature`,
  `issueTicket`), `redeem.ts` (`redeem()` ONE tx READ COMMITTED + `SELECT … FOR UPDATE` on Offer, maxWait/
  timeout 30 s, retries on deadlock; ALL reads on `tx` incl. `getMembership`/`getBalance`/`getSetting(key,
  tx)`/`evaluate({db: tx})` — a global-client read inside the tx needs a 2nd pool connection and DEADLOCKS
  the pool under a burst; keys spent at creation for every outcome; HELD links the member's open flags to
  the redemption; NOTIFIED waitlist entry → CLAIMED), `lifecycle.ts` (`startRedemptionPayment` Checkout
  mode payment `metadata.kind="redemption"` idempotency `redemption_pay_{id}` → `Redemption.
  stripeCheckoutSessionId` (migration `20261028210000_redemption_checkout_session`); `completeRedemptionPayment`
  updateMany PENDING→ACTIVE + ticket + email, late money refunded; `releaseHeldRedemption` (cash due →
  PENDING_PAYMENT w/ ≥24 h window, else ACTIVE + ticket), `denyHeldRedemption` (keys back, waitlist);
  `cancelRedemption(id, memberId|null)` (ACTIVE only until `cancelDeadlineAt`; PENDING/HELD any time; refundKeys
  + Stripe refund `refund_{id}`; waitlist); `expirePendingPayments`, `markNoShows` (ACTIVE→NO_SHOW,
  AttendanceStats.noShows++, pending→EXPIRED, waitlists EXPIRED, event FINISHED), `refundEventRedemptions`,
  waitlist `joinWaitlist`/`leaveWaitlist`/`notifyNextOnWaitlist` (`waitlist_claim_minutes`, email)/
  `expireWaitlistClaims`), `notify.ts` (confirmation/cancellation/waitlist emails, best-effort),
  `webhooks.ts` (`registerRedemptionWebhooks` on checkout.session.completed/async — `src/lib/stripe-webhook`
  now holds MANY handlers per type (array; handler returns null = not mine; notes joined); billing's
  handler returns null for kind "redemption"). Ledger `LedgerOptions.db` accepts a TransactionClient
  (`inTx` joins); billing `Opts.db` too; `getSetting(key, db?)`. fraud/review.ts approve → `releaseHeld
  Redemption`, deny/ban → `denyHeldRedemption`. Admin cancel-event action → `refundEventRedemptions`.
  Member app: `/app` (7-day window in member city, `?day=&type=&tag=`, `src/components/event-card.tsx`
  `eventTeaser`/`hoursUntilOpen`), `/app/events/[id]` (per-offer `checkEligibility` + waitlist actions in
  `src/app/app/events/actions.ts`), `/app/events/[id]/redeem/[offerId]` (sheet → `redeemAction`: PENDING →
  Checkout URL, HELD → `?held=1`, ACTIVE → `?new=1`), `/app/tickets` + `/app/tickets/[id]` (QR via `qrcode`
  toDataURL on white, cancel/pay actions in `src/app/app/tickets/actions.ts`); nav gained Tickets.
  Backoffice: redemptions table on event page, tickets on member page. Jobs `pnpm jobs:mark-no-shows`
  (hourly) / `jobs:expire-pending-payments` (5 min) / `jobs:expire-waitlist-claims` (5 min). Tests
  `tests/redemption.test.ts` (11 → suite 79).
- **Done — Phase 6 (scanner)**: `src/domain/scanner/` — `session.ts` (`createScannerToken`/`verifyScannerToken`:
  HMAC(AUTH_SECRET) token `{eventId, device, exp}`, cookie `siapp_scan` via `src/lib/scanner-auth.ts`
  `getScannerSession`/`requireScannerSession`/`scannerApiError`), `login.ts` (`loginScanner({code, pin, device})`
  → `{event, token, expiresAt}` = endsAt + 12 h; 5 wrong PINs lock the code 15 min — `Event.scannerFailedLogins/
  scannerLockedUntil`, migration `20261029090000_scanner_lockout` which also adds the `Scan.event` FK), `scan.ts`
  (`processScan({eventId, code, scannedBy, admitAfterWindow?, at?})` → `ScanOutcome{result, message, scanId,
  ticket?: TicketCard, firstScanAt?, checkedInAt?, afterWindow?}`; ticket by `qrPayload` + `verifyQrSignature`;
  CHECKED_IN → ALREADY_SCANNED, CANCELLED/EXPIRED/DENIED/NO_SHOW → CANCELLED, PENDING_PAYMENT/HELD/wrong event/
  unknown/tampered → INVALID, TIME_WINDOW past `validUntil` → WINDOW_CLOSED unless PAY_DOOR + `admitAfterWindow`;
  OK = tx `updateMany(ACTIVE→CHECKED_IN)` (count 0 → ALREADY_SCANNED, concurrency-safe) + `AttendanceStats.shows++`;
  one `Scan` row per attempt, `at` honoured when plausible), `counters.ts` (`scannerSummary`), `lookup.ts`
  (`searchTickets(eventId, q)` name/+1/email; `flagDispute({eventId, scanId, note})` → disputes++ once per scan),
  `offline.ts` (`ticketManifest`, `syncScans(eventId, QueuedScan[])` ordered replay + attached disputeNote).
  App: `/scan` (login form → `src/app/scan/actions.ts`; signed in → `scanner-client.tsx`: BarcodeDetector +
  `jsqr` fallback, manual code, name search, result flood with big selfie, PAY_DOOR admit button, dispute,
  localStorage cache `siapp_scan:{eventId}` {manifest, queue, localScanned}, offline provisional results,
  sync on `online`/45 s, "sync surprises"), API `POST /api/scan`, `GET /api/scan/state?manifest=0`,
  `POST /api/scan/sync`, `GET /api/scan/search?q=`, `POST /api/scan/dispute` (401 without cookie). Admin event
  page: "Open scanner" link + Door log (last 100 scans). Tests `tests/scanner.test.ts` (10 → suite 89).
- **Done — Phase 7 (referrals + partner claims)**: `src/domain/referrals/` — `status.ts` (`isReferralCodeActive` =
  paid && !tourist via getMembership, `referralLink`, `referralOverview(memberId)`, `inviteeLabel` "First L.",
  `monthStartUtc`), `vesting.ts` (`vestReferral(id, {now})` → `{outcome: vested|rejected|pending, reason}`: hard
  rejections self_referral / shared_device / shared_card → REJECTED + OPEN `SELF_REFERRAL` flag w/ evidence; then
  invitee_not_paid (earliest non-tourist `Subscription.firstPaidAt`) → refund_window (`referral_vesting_days`) →
  invitee_no_show_yet (CHECKED_IN count) → referrer_not_paid → monthly_cap (VESTED w/ vestedAt ≥ month start) →
  tx `updateMany(PENDING→VESTED)` + `grantPurchasedKeys` REFERRAL_BONUS refs `referral:{id}:referrer|invitee` +
  emails; `vestReferrals({referrerId?})` job), `notify.ts`. Onboarding records a referral only when the code is
  active (`inactive_code` result). `src/domain/partners/` — `jwt.ts` (`peekClaimToken`, `verifyClaimToken(token,
  pem)` RS256 only via node:crypto, required source/externalMemberId/exp, 60 s skew; `PartnerError{reason}`),
  `promo.ts` (`PromoSchema` PLAN_PERIOD{tier,months} | KEYS{keys} | STRIPE_COUPON{couponId}, `applyPromo`),
  `claims.ts` (`claimPartnerToken(memberId, token)`: community by `source` → verify → one claim per member per
  community → tx {PartnerClaim (unique community+externalMemberId, tokenJti) → promo → clear
  `Member.partnerClaimToken`}; P2002 → `already_used`; `claimStoredToken`), `communities.ts` (CRUD w/ PEM + promo
  validation). Billing: `startPromoPeriod({memberId, tierCode, months})` (no Stripe id, firstPaidAt null,
  nextGrantAt monthly, refuses a live Stripe sub); `runMonthlyGrants` rolls only FREE; `runExpirePeriods` expires
  any local non-FREE sub → FREE. Job `pnpm jobs:vest-referrals` (daily). Member app: `/app/referrals` ("Invite"
  tab; `share-button.tsx` Web Share → clipboard), membership "partner membership" card → `claimPartnerAction`,
  onboarding action claims the stored token (`?partner=`/`?partnerError=` on the welcome notice). Backoffice:
  `/admin/referrals` (+ `runVestingAction`), `/admin/partners` (+ `[id]`, ADMIN edits, `partner-form.tsx`),
  member page Referrals table + claims. `docs/PARTNER_TOKEN.md` = the EventOS contract. Tests
  `tests/referrals.test.ts` (6) + `tests/partners.test.ts` (6) → suite 101.
- **Done — Phase 8 (settlements)**: `src/domain/settlement/` — `calc.ts` (`owedCents(face, d)` = floor((face×(100−d)
  + 50)/100), half up), `settle.ts` (`settleEvent(eventId)` idempotent by `Settlement.eventId @unique`: FINISHED only;
  lines = tickets w/ redemption CHECKED_IN on DISCOUNT_TICKET offers; amount 0 → row PAID w/ reference
  `NOTHING_OWED`; `settleEvents()` job = FINISHED events `settlements: {none}` → settle + `sendSettlementEmail`
  (CSV attached, `emailedAt`; false w/o `Producer.contactEmail`); `markSettlementPaid(id, {reference})` updateMany
  OPEN→PAID; `reopenSettlement`; `settlementStatement(id)` → rows w/ member/+1/offer/scannedAt; `statementCsv`,
  `statementFilename`), `notify.ts`. `src/lib/email.ts` `SendEmailInput.attachments` + `setEmailSinkForTests`;
  `src/lib/csv.ts` (EventOS port: `escapeCsvCell`, `toCsv`, `csvResponse`, `eur`). Job `pnpm jobs:settle-events`
  (hourly). Backoffice `/admin/settlements` (+ `actions.ts` markPaid/reopen ADMIN, resend/run OPS; shared
  `settlement-row.tsx` also used on the producer page), `GET /api/admin/settlements/[id]/csv` (OPS+), dashboard
  tiles (open settlements €, redemptions 30 d, no-show rate, fraud queue). Tests `tests/settlement.test.ts` (4 →
  suite 105). Open: +1 cash on discounted tickets is NOT settled (owner decision pending).
- **Done — Phase 9 (notifications + cron)**: `src/domain/notifications/` — `log.ts` (`notifyOnce({memberId, kind,
  reference}, send)` claims a `NotificationLog` row (unique memberId+kind+reference — migration
  `20261029120000_notification_log`), sends, stamps `sentAt`; failure deletes the claim; never throws),
  `emails.ts` (`emailWelcome`, `emailPlanKeysGranted({renewal})`, `emailKeysExpiring`, `emailEventReminder` (cutoff
  wording from `cancelDeadlineAt` vs now), `emailNoShow`, `emailPaymentFailed`, `emailTouristExpiring`), `jobs.ts`
  (`sendEventReminders` ACTIVE + event starts within 25 h, ref redemptionId; `sendKeysExpiringNotices` KeyBalance
  planKeys>0 & expireAt within 3 d, ref expireAt ISO, re-checked via `getBalance`; `sendTouristExpiringNotices`
  within 24 h, ref sub id). Hooks: billing `grantForSubPeriod` → plan_keys_granted ref = grant reference, never
  FREE; `markPastDue(id, {invoiceId})` → payment_failed; `markNoShows` → no_show; `completeOnboarding` → welcome
  (first time; dynamic imports to dodge cycles). Cron: `src/lib/cron-jobs.ts` `CRON_JOBS` registry (12 names) +
  `cronAuthorized`/`runCronJob`; route `GET /api/cron/[job]` (Bearer CRON_SECRET, unset = refuse, 404 unknown);
  `vercel.json` schedules all 12 (5-min / hourly staggered / daily); `pnpm jobs:event-reminders|keys-expiring|
  tourist-expiring`. `src/lib/email.ts` `setEmailSinkForTests`. Tests `tests/notifications.test.ts` (9 → suite
  114). Owner decisions are tracked in `docs/DECISIONS_PENDING.md`.
- **Done — Phase 10 (polish, PWA, legal, e2e, runbook)**: PWA — `src/app/manifest.ts`, `public/sw.js` (network-first
  navigations; pages cache for /app, /app/wallet, /app/tickets*, /scan, /offline; cache-first `_next/static`;
  SWR media; never `/api/*`), `src/components/pwa-register.tsx` (prod always, dev with `?sw=1`), `/offline`,
  icons in `public/icons/` (sharp from `public/icon.svg`), security headers + `Service-Worker-Allowed` in
  `next.config.ts`. i18n — next-intl w/o routing: `src/i18n/request.ts` (locale en), `messages/en.json`,
  provider in root layout; sign-in / legal nav / offline use `getTranslations`. Legal — `src/app/legal/{terms,
  privacy,cookies}` + layout w/ draft banner, `.legal` CSS, `src/components/legal-footer.tsx`; membership plan
  grid is ONE form (`button name="planPriceId"`) with the auto-renewal disclosure + required `acceptTerms`
  (checked again in `choosePlanAction`); redeem sheet MoR note for cash offers. Deletion —
  `src/domain/identity/deletion.ts` `deleteAccount(memberId)` (cancel cancellable redemptions, Stripe
  `subscriptions.cancel` (added to `BillingStripe` + test fakes), expire plan keys, remove photos/devices/
  sessions, anonymise row, `Member.deletedAt` — migration `20261029150000_member_deleted_at`), `/app/profile/delete`
  + `deleteAccountAction` (type DELETE, signOut → `/sign-in?deleted=1`). Scanner a11y (min-h-11/12 targets,
  `role="status" aria-live`, labels). `src/lib/email.ts` `EMAIL_OUTBOX_DIR` (dev: JSON per email). E2E —
  `pnpm e2e` = `playwright.config.ts` (embedded PG 5435 `.e2edb`, `e2e/global-setup.ts` → `e2e/provision.ts` via
  tsx, next dev :3100, outbox `e2e/.outbox`, `STRIPE_WEBHOOK_SECRET=whsec_e2e`), `e2e/flow.spec.ts` (signup →
  signed synthetic Stripe webhooks → redeem → scan → cancel in/out of window). `docs/RUNBOOK.md`. Tests
  `tests/deletion.test.ts` (1 → suite 115) + e2e 4. ALL 10 PHASES DONE — next: owner decisions
  (`docs/DECISIONS_PENDING.md`), launch checklist in `docs/BUILD_PLAN.md`.
- **Done — DEPLOYED (2026-10-29)**: production `https://siapp-two.vercel.app` — Vercel project `siapp`
  (team `marcio-3161s-projects`, Pro, `fra1`, Node 22, git-connected to `marcio300/siapp`, production
  branch `main`; first deploy created by API from the build branch), DB = separate database `siapp` in
  the existing Neon EU project `eventos-db-eu` (`hidden-fog-56235864`; a dedicated Neon project needs
  the owner to approve marketplace billing), Vercel Blob `siapp-media`, Resend key + EventOS's
  verified sender domain, generated `AUTH_SECRET`/`DATA_ENCRYPTION_KEY`/`CRON_SECRET`; migrations run
  in the Vercel build (`vercel.json` `buildCommand: pnpm db:deploy && pnpm build`), seed ran in the
  first build. STRIPE keys NOT set (owner). Full state + the sandbox-can't-reach-Neon gotcha in
  `docs/RUNBOOK.md` §3 "Current deployment".
- **Done — Phase 11 (EventOS partner API — SIAPP side of `docs/EVENTOS_INTEGRATION.md`, contract = EventOS
  `docs/SIAPP_API.md`)**: schema — enums `EventSource` (MANUAL|EVENTOS) + `PaymentMode` (SIAPP_COLLECTS|
  PRODUCER_COLLECTS); `Producer.eventosOrgId @unique/eventosOrgName/eventosAppUrl/eventosWebhookUrl/
  eventosWebhookSecretEnc/eventosPreviousSecretEnc/eventosPreviousSecretUntil/eventosConnectedAt` (the webhook
  secret is what SIAPP SIGNS WITH → stored ENCRYPTED via `encryptText`, not hashed — the build-plan's "hash"
  was unworkable; previous secret valid 24 h), `ProducerApiKey` (prefix + sha256 `keyHash @unique`, one active
  per producer, `createdBy` StaffUser, `lastUsedAt` stamped ≤ once/min), `PartnerIdempotency` (unique
  producer+key, requestHash, status, response Json, 24 h replay), `Event.source/externalId/snapshotVersion/
  pausedAt` (+ `@@unique([producerId, externalId])`), `Offer.externalRef/paymentMode/keyCostOverride`
  (+ `@@unique([eventId, externalRef])`) — migration `20261109090000_eventos_partner_api`. Settings (+11, seeded):
  `key_value_cents` 100, `min_key_cost` 2, `guestlist_key_cost` 10, `key_cost_override_pct` 0,
  `min_discount_percent` 10, `max_discount_percent` 99, `partner_payment_hold_minutes` 15,
  `eventos_noshow_grace_hours` 6, `partner_photo_ttl_hours` 24, `partner_max_offers_per_event` 10,
  `partner_rate_limit_per_minute` 120. `src/domain/partners-api/` — `errors.ts` (`PartnerApiError{status, code,
  details, headers}` → contract envelope), `keys.ts` (`generateApiKey` `siapp_pk_<8>_<32>` base62, `verifyApiKey`
  → unauthorized|producer_revoked, `createProducerApiKey` revokes the active one, `revokeProducerApiKeys`),
  `auth.ts` (`requireProducerKey(req)` bearer → producer+city, in-memory fixed-window `checkRateLimit` per key id
  w/ `Retry-After`; `resetRateLimitForTests`), `idempotency.ts` (`withIdempotency` replay byte-for-byte w/
  `Idempotency-Replayed: true`, different body → 422 `idempotency_mismatch`, 5xx never stored), `http.ts`
  (`partnerRoute(req, handler, {idempotent})` = auth → JSON body → idempotency → `X-Request-Id` + `no-store`;
  Zod/JSON errors → 422), `pricing.ts` (`CONTRACT_VERSION "2026-11-08"`, `computeKeyCost({mode, priceCents,
  discountPercent, override}, pricing)` = THE pricing rule: FULL value=face, DISCOUNT value=round(face×d%),
  keys=max(min, ceil(value/keyValue)), GUESTLIST fixed, override wins; `memberPriceCents`; `loadPricing/loadLimits`
  from settings; `MODE_TO_TYPE` FULL→FREE_TICKET etc.), `snapshot.ts` (`EventSnapshotSchema/OfferSpecSchema` zod =
  contract §2.2/2.3; pure `validateSnapshot` → 422 detail codes `id_mismatch ends_before_starts event_in_past
  too_many_offers duplicate_ref ref_invalid face_value_required discount_out_of_range capacity_required
  capacity_exceeds_type window_required private_sale_invalid offer_frozen capacity_below_redeemed
  offer_has_redemptions`; warnings `ends_at_defaulted` (+6 h), `guestlist_capacity_ignored`, `timezone_mismatch`;
  `applySnapshot(producer, eventosEventId, raw)` ONE tx: `stale_version` 409 when version < stored (equal =
  re-apply), 409 `conflict` for staff-managed/finished/cancelled, event create (DRAFT, source EVENTOS, cityId from
  producer, scanner creds minted, PIN discarded — EventOS scanner is the door) or update, offers upsert by
  `externalRef` (name = ticket type name + "· d% off" / "· guest list"; FULL/DISCOUNT → CAPPED, GUESTLIST →
  TIME_WINDOW via `windowUntilFromLocalTime` + capacity ignored; `faceValueCents` stored for FULL too so the
  rule can recompute; +1 extra key cost = the offer's key cost (same value → same keys), +1 cash DISCOUNT only;
  private sale opens-at from `publishedAt` when already published; live offers KEEP their keyCost unless a
  staff override exists; `paymentMode` always PRODUCER_COLLECTS), missing offers deleted only with zero
  redemptions (waitlist rows too), returns `OfferResult[]` w/ per-status counters), `status.ts` (`publish`
  (DRAFT → `setEventStatus`, "no offers" → 422 `no_offers`; always clears `pausedAt`), `pause` (= `pausedAt`,
  status stays PUBLISHED), `cancel` (DRAFT direct / PUBLISHED via setEventStatus + `refundEventRedemptions` —
  keys only since PRODUCER_COLLECTS redemptions have no PaymentIntent; idempotent, returns `{redemptions, keys}`)),
  `sales.ts` (`offerCountersByStatus`, `toOfferResult`, `salesForEvent(eventId, {since, cursor, limit})` ordered
  updatedAt/id asc w/ base64url cursor; `RedemptionView.member.email` ONLY when `cashCents > 0` (decision C),
  displayName via `inviteeLabel`), `connect.ts` (`connectProducer` zod → 409 `producer_bound` on a different
  org, rotates `whsec_` secret, sets `usesEventOS`, returns contract/producer+city/pricing/limits/webhookSecret/
  scannerPhotoTtlHours; `webhookSecrets(producer, now)` current+previous decrypted; `unbindProducer`), `photo.ts`
  (`photoSignature(secret, ticketId, exp)` HMAC hex, `verifyPhotoSignature(secrets…)` ok|expired|bad timing-safe,
  `signedPhotoUrl(producer, ticketId, endsAt)` exp = endsAt + ttl, `loadTicketPhoto` via media storage `get`),
  `override.ts` (`setOfferKeyCostOverride(offerId, n|null)` ADMIN — recomputes keyCost + +1 keys; existing
  redemptions keep what they paid). Routes `src/app/api/partner/v1/`: `connect` POST, `pricing` GET,
  `events/[eventosEventId]` PUT, `…/publish|pause|cancel` POST (all idempotent), `…/sales` GET, `…/settlement` GET
  (always 404 `no_settlement`), `tickets/[ticketId]/photo` GET (query-signed, no bearer, 403/410/404, no-store).
  Redemption: `RefusalReason` gained `EVENT_PAUSED` (`checkEligibility` right after the PUBLISHED check;
  `joinWaitlist` too); `/app` listing adds `pausedAt: null`. Domain guards: `updateEvent/addOffer/updateOffer/
  deleteOffer` refuse `source = EVENTOS` ("managed in EventOS"). Backoffice: producer page "EventOS connection"
  card (key prefix/created/last used, bound org, webhook URL; ADMIN generate key → `?apiKey=` shown once,
  revoke, "Disconnect EventOS" = revoke + unbind), event page for EVENTOS events = banner "Managed in EventOS by
  {producer}" (snapshot version + external id), read-only details, no offer forms/add/delete/duplicate/
  unpublish, "Emergency cancel" only, per-offer ADMIN key-cost override form (`overrideKeyCostAction`),
  scanner card copy says the EventOS scanner is the door; `EventOS` badge on event lists. Tests
  `tests/partners-api.test.ts` (12 → suite 127; routes called directly with `Request` objects): key format/
  verify/revoke/lastUsedAt, pricing table (€15→15, 40 % of €20→8, floor 2, guest list 10, override),
  rate-limit window, 401 codes, connect bind/rotate/previous-secret window/producer_bound/422, every
  validation code + "422 applies nothing", upsert fields (window UTC, +1 keys, face value, private sale),
  idempotency replay + mismatch, stale_version, publish/no_offers/404/pause → `EVENT_PAUSED` + listing filter →
  publish clears, frozen/offer_has_redemptions/capacity grows/key cost sticks through a pricing change/staff
  override wins/staff edit refused, sales email rule + counters + cursor + since, settlement 404, photo test
  vector + route ok/403/410/404, cancel refunds keys (ledger) idempotently + later push/publish 409. NOT in 11
  (Phase 12/13): outbound events to EventOS, `externalOrderId/externalTicketId` (sales returns null), external
  check-ins, producer-collects payment flow, no-show grace.
- **Done — Phase 12 (outbound events, mirror tickets, external check-ins — contract §1.2/§3.7/§4)**: schema —
  enums `ScanSource` (SIAPP|EVENTOS) + `OutboundStatus` (PENDING|SENT|FAILED); `OutboundEvent` (id = ULID envelope id,
  producerId, eventId?, type, payload Json, `dedupeKey @unique`, status, attempts, nextAttemptAt, lastError,
  responseStatus/responseBody, sentAt); `Ticket.externalTicketId/externalOrderId`; `Scan.source` + `Scan.externalId
  @unique` (EventOS check-in id) — migration `20261109150000_eventos_outbound`. `src/domain/partners-api/outbox.ts`:
  `ulid()`, `signEnvelope(secret, t, body)` = HMAC-SHA256 hex over `"t.body"` + `signatureHeader` (`t=…,v1=…`;
  contract §1.2 test vector in the tests), `queueOutbound(producer, type, data, {eventId, dedupeKey, notBefore})`
  (null when the producer has no org/webhook; a dedupeKey re-arms a SENT/FAILED row, leaves a PENDING one),
  `flushOutbound({ids?, now, fetchImpl})` (due PENDING rows → POST envelope `{id, type, producerId, eventosOrgId,
  createdAt, data}` to `Producer.eventosWebhookUrl` signed with the CURRENT secret (`webhookSecrets[0]`); 2xx → SENT +
  reply stored + `onDelivered` (default: `redemption.activated` reply `{ticketId, orderId}` → Ticket external ids);
  retryable = network error / 408 / 429 / 5xx → `OUTBOUND_BACKOFF_MS` 1 m/5 m/15 m/1 h/6 h then FAILED; other 4xx →
  FAILED at once), `retryOutbound(id)` (FAILED → PENDING, attempts 0), TEST SEAM `setOutboundFetchForTests`.
  `hooks.ts` (best-effort, swallow + console.error; deliver immediately via `flushOutbound({ids})` unless inside a tx
  client): `notifyRedemptionActivated(id)` — ONLY `source = EVENTOS` + FREE_TICKET/GUESTLIST + ticket exists (DISCOUNT
  → null: EventOS activates those via `order.paid`, Phase 13); payload §4.1 = redemptionId, siappEventId,
  eventosEventId, offerRef, ticketTypeId (from the ref), qrPayload, `member.displayName` (`inviteeLabel`, NO email),
  plusOneName, `photoUrl/photoExpiresAt` (`signedPhotoUrl`), keyCost, `window {validUntil, afterWindow}` for guest
  lists; `notifyRedemptionCancelled(id, reason member|staff|event_cancelled|denied|expired, {wasActive, cashCents})`
  → `refundCash = wasActive && cash > 0`; `notifyTicketCheckedIn({redemptionId, qrPayload, at, gate, scanId})`;
  `queueSalesUpdated(eventId)` dedupeKey `sales:{eventId}` — PENDING row absorbs, SENT row re-armed no sooner than
  `sentAt + 30 s` (`SALES_UPDATED_WINDOW_MS`); `notifySalesUpdated`; `disconnectProducer(producerId, key_revoked|
  staff)` = queue `producer.disconnected` + flush NOW (the secret is about to go) → revoke keys (+ unbind for staff).
  Hook sites: `redeem` (ACTIVE → activated, else sales.updated), `releaseHeldRedemption`, `denyHeldRedemption`
  (denied), `cancelRedemption` (member when memberId given, else staff), `expirePendingPayments` (expired),
  `refundEventRedemptions` (event_cancelled), `markNoShows` (sales.updated), `processScan` OK on an EVENTOS event
  (`ticket.checked_in`, event select gained `source`), producer actions `revokeApiKeyAction`/`unbindEventOSAction` →
  `disconnectProducer`. `checkin.ts` `recordExternalCheckIn(producerId, redemptionId, body, {now})` (route `POST
  /api/partner/v1/redemptions/[redemptionId]/checkin`, idempotent): zod `{at, gate?, device?, eventosCheckInId}`;
  404 unknown, 403 `forbidden` for another producer's redemption; replay by `Scan.externalId` (`replay: true`);
  `at` clamped to [startsAt − 24 h, now]; results OK (conditional ACTIVE → CHECKED_IN + `shows++` + Scan `source
  EVENTOS`, `scannedBy "eventos:{gate|device|door}"`) / ALREADY_SCANNED (+ `firstScanAt`) / CANCELLED (CANCELLED,
  EXPIRED, DENIED, or NO_SHOW older than `NO_SHOW_REVERSAL_HOURS` 48 after endsAt) / INVALID (PENDING_PAYMENT, HELD,
  no ticket); NO_SHOW within 48 h → CHECKED_IN, `noShows--` (floored) `shows++`, `reversedNoShow: true`; every
  attempt writes ONE Scan row; OK → sales.updated. `markNoShows` filters `source = EVENTOS` events to `endsAt +
  eventos_noshow_grace_hours ≤ now`. Cron `partner-outbox` (`* * * * *`, 13 crons now) + `pnpm jobs:partner-outbox`.
  UI: member ticket page "preparing for the door" while `externalTicketId` is null on an EventOS FULL/GUESTLIST
  ticket; admin event page "Messages to EventOS" table (last 50: type/status/attempts/next/last error, Retry button →
  `retryOutboundAction` OPS = `retryOutbound` + immediate flush), scanner-login card collapsed into `<details>` for
  EventOS events. Tests `tests/partners-outbound.test.ts` (10 → suite 137): §1.2 test vector + header + ULID order,
  FULL redemption through `redeem()` → signed envelope verified with the secret, payload fields, photo URL verifies,
  reply → external ids, SENT row w/ eventId; GUESTLIST window + DISCOUNT → nothing; 503 → +1 m, not due at +30 s,
  network error → +5 m, 404 → FAILED, staff retry → SENT, six 5xx → FAILED; sales.updated coalescing (one row, re-arm
  at sentAt + 30 s); cancellation reasons member/staff/denied/expired/event_cancelled + refundCash; our scan →
  ticket.checked_in; external check-in OK/replay/ALREADY_SCANNED/403/404/422/CANCELLED/INVALID + shows; grace
  (manual event finishes at +1 h, EventOS events at +7 h) + reversal at +8 h, refused at +49 h; disconnect
  key_revoked then staff (binding + secrets gone). `tests/notifications.test.ts` cron count 12 → 13.
- **Done — Phase 13 (producer-collects payments — contract §4.2/§3.8/§5; owner decision A)**: schema —
  `Redemption.qrPayload @unique` (minted in `redeem()` for DISCOUNT_TICKET offers with `paymentMode =
  PRODUCER_COLLECTS`; the `Ticket` row is created only on `order.paid`), `externalOrderId`, `externalPayUrl`,
  `externalRefundedAt`, `externalRefundError` — migration `20261109180000_producer_collects_payments`; such a
  redemption's own window is `partner_payment_hold_minutes` (how long the member has to START paying), replaced
  by EventOS's hold expiry once the order exists. `src/domain/partners-api/payments.ts` — `requestExternalOrder
  (redemptionId, {db, now, fetchImpl})`: SYNCHRONOUS `order.create` command (envelope `{id: ulid, type,
  producerId, eventosOrgId, createdAt, data}` signed with `signatureHeader` + the CURRENT secret, POST to
  `Producer.eventosWebhookUrl`, fetch = `currentOutboundFetch()` so the outbox test seam applies; NOT an outbox
  row — the member is waiting) with data `{redemptionId, siappEventId, eventosEventId, ticketTypeId (from the
  ref), offerRef, qrPayload, unitPriceCents = memberPriceCents(face, d), faceValueCents, discountPercent,
  plusOne {name, extraCashCents}|null, expectedTotalCents = cashCents, buyer {name, email} (decision C),
  holdMinutes, memberDisplayName, photoUrl/photoExpiresAt}`; 2xx `{orderId, payUrl, holdExpiresAt,
  totalCents?}` → stored on the redemption (`paymentExpiresAt = holdExpiresAt`); a stored link whose hold is
  still live is returned WITHOUT a new call; terminal refusals (`ORDER_CREATE_TERMINAL` = sold_out |
  price_mismatch | event_not_live | offer_unknown | discount_below_floor, any non-408/429 4xx carrying one of
  those codes) → redemption CANCELLED + `refundKeys` + `sales.updated`, throw `ExternalOrderError{code,
  terminal: true}` with member copy `ORDER_CREATE_MESSAGES` (no `redemption.cancelled` — EventOS held nothing);
  anything else → `ExternalOrderError("unavailable")`, redemption untouched. `completeExternalPayment(producerId,
  redemptionId, body, {db, now})` (route `POST /api/partner/v1/redemptions/[redemptionId]/payment`, idempotent
  via `partnerRoute`; 404 unknown, 403 another producer's; zod discriminated union on `kind`): `order.paid
  {orderId, paidAt?, amountCents?, ticket {id, qrToken}}` → `409 qr_mismatch` when `qrToken ≠ Redemption.qrPayload`
  (a null payload adopts the token), else ONE tx conditional PENDING_PAYMENT → ACTIVE (`paymentExpiresAt` null,
  `externalOrderId`) + Ticket `{qrPayload, signature: signQrPayload, memberName, photoSnapshotUrl, plusOneName,
  externalTicketId, externalOrderId}` + waitlist NOTIFIED → CLAIMED, then `emailRedemptionConfirmed` +
  `notifySalesUpdated`; non-PENDING → `{outcome: "noop", ticketId}` (replay); `order.expired` → EXPIRED +
  `refundKeys` + `notifyNextOnWaitlist` (lazy import of lifecycle) only while PENDING; `refund.succeeded` →
  `externalRefundedAt` (clears the error); `refund.failed` → `externalRefundError`. Returns `{redemptionStatus,
  outcome completed|expired|recorded|noop, ticketId?}`. `lifecycle.ts`: `startRedemptionPayment(id, memberId,
  {fetchImpl?})` is the dispatcher → `{url, via: "stripe"|"eventos"}` (PRODUCER_COLLECTS → `requestExternalOrder`;
  terminal `ExternalOrderError` → `RedemptionError("BAD_STATE", msg, {code})`, unavailable → "payment page isn't
  answering… spot is still held"; SIAPP_COLLECTS → Stripe Checkout exactly as before); `cancelRedemption` /
  `refundEventRedemptions` include `offer.paymentMode` and for producer-collects ACTIVE cash SKIP Stripe and report
  `cashRefundedCents = cashCents` (EventOS refunds on `redemption.cancelled refundCash`, then reports
  `refund.*`); `expirePendingPayments` leaves redemptions with an `externalOrderId` alone until `paymentExpiresAt +
  EXTERNAL_HOLD_GRACE_MS` (2 min) so EventOS's `order.expired` arrives first. `redeem.ts` mints `qrPayload` +
  uses the partner hold for producer-collects. `settle.ts` lines require `offer.paymentMode = SIAPP_COLLECTS`
  (an EventOS event → 0-amount PAID `NOTHING_OWED` row); `/admin/settlements` + producer page include
  `event.source` and label it "collected by producer". `sales.ts` `RedemptionView.externalOrderId/externalTicketId`
  filled (redemption, then ticket). `errors.ts` code `qr_mismatch`; `outbox.ts` `currentOutboundFetch()`.
  Member app: redeem sheet (`producerCollects` → "you pay {producer} on the next screen", MoR note names the
  producer + says name/email go to them, button "Continue to pay €X at {producer}"), ticket page ("Pay €X at
  {producer}", confirmation copy names the producer, cancel copy "(refunded by {producer})"); admin member page
  Tickets table gained a Cash column (via SIAPP / paid to producer · order / refunded by producer / RED
  "refund failed at producer — follow up" w/ the error as title). Tests `tests/partners-payments.test.ts`
  (11 → suite 148): PENDING + minted payload + no ticket + partner window; signed synchronous `order.create`
  payload + stored order/url/hold + retry w/o a second call + no outbox row; price_mismatch/sold_out → CANCELLED
  + keys back + typed error; 5xx + network → still PENDING, then success; `order.paid` → ACTIVE + signed ticket w/
  external ids + email, `qr_mismatch` 409 untouched, idempotent replay header, same key other body → 422
  `idempotency_mismatch`, repeat → noop, one ticket; 403/404/422; `order.expired` → EXPIRED + keys, replay noop,
  late `order.paid` noop, sweep respects the grace then expires + `redemption.cancelled expired`; cancel ACTIVE
  → keys + no Stripe + `refundCash: true`, cancel PENDING → `refundCash: false`; refund.failed/succeeded
  bookkeeping; settlement 0/PAID/NOTHING_OWED with a scanned producer-collects ticket; SIAPP_COLLECTS → Stripe
  session, no payload, no EventOS call. Test gotcha: `getBalance` deltas need `getMembership()` called once
  first (the lazy FREE subscription grants 2 plan keys on first touch); `sales.updated` is coalesced per event,
  so don't assert a fresh one right after another message. **E2E VERIFIED 2026-11-09 against a local EventOS over real HTTP** (report: EventOS `docs/SIAPP_E2E_Run_2026-11-09.md`; SIAPP-side runner `scripts/e2e-eventos/` = `pg-keep.ts` (embedded PG on 5436 — dev-local hardcodes 5433 which EventOS uses), `setup-db.ts`, `cli.ts` producer/member/redeem/pay/scan/cancel/eligibility/noshow/state/outbound/sql): connect, snapshot + publish, FULL → mirror ticket, both scanners, DISCOUNT +1 `order.create` → `order.paid`, `order.expired`, cancel → `refund.succeeded`, sales, pause/publish, no-show reversal all matched the contract. One bug fixed: `flushOutbound` signed with the caller's logical `now` (a job with a shifted clock → EventOS 401 `stale`) — now the wall clock, test added (suite 149). Also: the Stripe webhook route used `??` on `STRIPE_SECRET_KEY`, so an EMPTY value in `.env` made the SDK throw → every webhook 400 (now `||`). `next dev` works in this cloud sandbox.
- **Phase 0 decisions to know**: `Member.cityId` is nullable until onboarding (Phase 3) — the magic link
  creates the row before any profile exists. Spec's "50 keys / €18" placeholder broke the spec's own
  "packs never cheaper per key than REGULAR" rule, so it's seeded at €20 (test enforces the rule). FREE
  only gets a MONTHLY plan. shadcn/ui never needed (hand-rolled components on the brand tokens). `vercel.json` crons landed in Phase 9.
- **Gotchas**: embedded-postgres tarballs can't carry the `lib*.so.N` / `*.dylib` symlinks their binaries
  need; the package's postinstall recreates them from `native/pg-symlinks.json`, but pnpm 10 skips install
  scripts unless listed in `package.json` `pnpm.onlyBuiltDependencies` (done: embedded-postgres platform
  packages, prisma, esbuild, sharp) — and `scripts/embedded-pg.ts` rebuilds the links from that manifest
  on every start anyway (any platform). When running as root (cloud sandboxes) the data dirs
  must be owned by the `postgres` user: `mkdir -p .devdb .testdb && chown postgres .devdb .testdb`.
  `$queryRaw` on catalog columns of type `name` fails with the engine-less client — cast to `::text`.
  `next build` and `next dev` share `.next`; never run both at once. Don't `pkill -f "next dev"` from a
  shell whose own command line contains that string.
