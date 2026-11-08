# SIAPP Build Plan

Eleven phases, each a separate Claude Code session (or a few). Each phase ends with tests green and a
commit. Prompts below are written to be pasted into Claude Code as-is; they assume `CLAUDE.md`,
`docs/` and `prisma/schema.prisma` are in the repo and `../eventos` is cloned alongside.

How to run this: open Claude Code in the new repo, paste the **Phase 0** prompt, review, commit, move
on. Don't skip the "port from EventOS" step — it's what keeps this a 6-week build instead of a 6-month
one. If Claude Code proposes something that contradicts `docs/PRODUCT_SPEC.md`, point it at the spec.

Suggested first message for every session:

> Read CLAUDE.md, docs/PRODUCT_SPEC.md, docs/DATA_MODEL.md and docs/BUILD_PLAN.md. We are on Phase N.
> Before writing code, list what you'll port from ../eventos and what you'll write new, then proceed.

---

## Phase 0 — Scaffold and port the shell

**Goal:** a running Next.js app with the EventOS stack, auth, DB, Stripe wiring and the backoffice shell,
with no SIAPP business logic yet.

**Port from EventOS:** project config (tsconfig, eslint, tailwind, shadcn setup), NextAuth config and
Prisma adapter tables, Prisma client singleton, Stripe client + webhook route skeleton with idempotency,
email provider setup and base template, backoffice layout (sidebar, auth guard, table components),
environment handling, Vercel config.

**Prompt:**

> Phase 0. Scaffold this repo as a Next.js App Router + TypeScript strict project mirroring the structure
> of ../eventos. Port from ../eventos: tooling config, NextAuth (email magic-link only, no SMS/OAuth for
> now) with Prisma adapter, the Prisma client singleton, the Stripe client and webhook route including its
> idempotency pattern (adapt to our `StripeEvent` model), the transactional email setup and base template,
> and the backoffice layout/auth guard/table primitives. Rename anything EventOS-specific to the SIAPP
> glossary in CLAUDE.md. Replace the schema with prisma/schema.prisma, add the NextAuth tables attached to
> `Member`, and write `prisma/seed.ts` that seeds: city Lisbon (Europe/Lisbon, EUR), tiers FREE/SOCIAL/
> REGULAR/PLUS with the placeholder key amounts from the spec, plans for each tier × monthly/quarterly/
> yearly plus TOURIST_WEEK, two key packs, the global Settings listed in docs/DATA_MODEL.md, and one ADMIN
> staff user from env. Stripe prices: write a script `scripts/sync-stripe-prices.ts` that creates/updates
> Stripe Products and Prices from the Plan/PlanPrice/KeyPack rows and stores the price ids back. Add
> Vitest with a Postgres test database (document how to point it at a Neon branch) and a smoke test that
> the seed runs. `pnpm dev`, `pnpm test`, `pnpm db:seed` must work. Commit.

**Done when:** app boots, magic-link login works for a seeded member and a staff user, backoffice shell
renders behind the staff guard, Stripe webhook endpoint verifies signatures and records `StripeEvent`.

---

## Phase 1 — Keys ledger

**Goal:** the core domain module everything else depends on.

**Prompt:**

> Phase 1. Implement `src/domain/keys`: `grantPlanKeys(memberId, amount, expiresAt, ref)`,
> `grantPurchasedKeys(memberId, amount, type, ref)`, `spendKeys(memberId, amount, redemptionId)` which
> debits PLAN first then PURCHASED and returns the per-pool breakdown, `refundKeys(redemptionId)` which
> mirrors the debit rows, `expirePlanKeys(memberId, periodEnd)` which writes an EXPIRY row for the
> unused remainder, `getBalance(memberId)`. Every write updates `KeyBalance` in the same transaction.
> Add a nightly reconciliation job `scripts/jobs/reconcile-balances.ts` that recomputes balances from the
> ledger and reports mismatches. Write Vitest tests for invariants 1, 2 and 4 in docs/DATA_MODEL.md plus:
> spending across both pools produces two rows; refund after cross-pool spend restores both; expiry never
> touches PURCHASED. Add a backoffice member page section showing both pools and the ledger with filters,
> and an "adjust keys" action (ADMIN only) that requires a reason. Commit.

---

## Phase 2 — Membership and billing

**Goal:** members can subscribe, upgrade, cancel, buy packs and the tourist pass; keys are granted
automatically.

**Port from EventOS:** Stripe Checkout session creation, customer portal link, webhook handlers for
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated/deleted`.

**Prompt:**

> Phase 2. Implement `src/domain/billing`. Subscription checkout via Stripe Checkout for any Plan/
> PlanPrice; key packs via Checkout one-off; tourist pass via Checkout one-off that creates a
> `Subscription` with `TOURIST_WEEK`, `currentPeriodEnd = now + 7d`, no Stripe subscription. Webhooks:
> on `invoice.paid` for a monthly plan → set period, call `grantPlanKeys` with `expiresAt =
> currentPeriodEnd`, set `firstPaidAt` if null; for quarterly/yearly → grant the first month and set
> `nextGrantAt = +1 month`; `checkout.session.completed` for packs → `grantPurchasedKeys(PACK_PURCHASE)`.
> Job `scripts/jobs/monthly-grants.ts` grants for subscriptions with `nextGrantAt <= now` and expires
> the previous month's plan keys. Job `scripts/jobs/expire-periods.ts` expires plan keys at period end
> and marks tourist passes EXPIRED. Upgrades: Stripe proration; key grant for the new tier applies from
> the next period (document this in the UI). Cancel = cancelAtPeriodEnd. FREE tier: a Subscription row
> with no Stripe id, created at signup. Member app: Membership screen (current plan, keys per month,
> renewal date, upgrade/downgrade, cancel, tourist pass), Wallet screen (plan keys + expiry, purchased
> keys, buy packs, ledger). Backoffice: Plans & packs page (edit amounts → `sync-stripe-prices`).
> Tests: invariant 11 (webhook replay no-op), grant on invoice.paid, quarterly monthly cadence, FREE
> cannot buy packs. Commit.

---

## Phase 3 — Identity, onboarding, fraud foundation

**Goal:** signup flow with the controls in spec §10, and the fraud queue.

**Prompt:**

> Phase 3. Build onboarding: email magic link → name, date of birth with explicit 24+ attestation
> (reject under 24), city select (only active cities), optional referral code (store in cookie if it came
> from a link), optional partner claim token (Phase 7 will implement verification; stub it now). Block
> disposable email domains using a maintained list in `src/domain/fraud/disposable-domains.ts`. Selfie
> capture step (camera on mobile, upload fallback) stored in Vercel Blob or the same storage EventOS
> uses; selfie is required before first redemption, not at signup. Device fingerprint on login (use an
> open-source fingerprint lib) → upsert `Device`; if a fingerprint is on more than
> `device_max_accounts` members, write a `FraudFlag(DEVICE_MAX_ACCOUNTS)`. Implement
> `src/domain/fraud/evaluate(memberId, offerId)` returning ALLOW | REVIEW with rules DEVICE_MAX_ACCOUNTS,
> VELOCITY_FIRST_HOUR (settings-driven), OVERLAP (active redemption for an event starting within
> `overlap_tolerance_hours`), and a SAME_CARD check using Stripe payment method fingerprint across
> customers. Backoffice: Fraud queue (open flags with evidence; approve/deny; ban member), Members list/
> search/detail with selfie, devices, flags, attendance stats, ID photo review for tourists with a
> 30-day purge job. Tests for each rule. Commit.

---

## Phase 4 — Producers, events, offers (backoffice)

**Goal:** staff can run the whole supply side.

**Prompt:**

> Phase 4. Backoffice CRUD for Producers (incl. payout details encrypted at rest, usesEventOS flag) and
> Events with nested Offers exactly as spec §6: offer type, key cost, face value + discount %, allocation
> CAPPED (capacity) or TIME_WINDOW (enter a local time like 02:00, store absolute UTC using the city
> timezone; afterWindow REFUSE/PAY_DOOR), private sale (tier multi-select + 24/48h → compute
> `privateSaleOpensAt` from publish time, editable), openToFree, +1 (allowed, extra keys, extra cash),
> cancellation window override, maxPerMember, redeem window. Event publish/unpublish/cancel/finish,
> duplicate event, generate scanner code + PIN on create (show PIN once). Event list filtered by city and
> date, with per-offer counters (redeemed / capacity). Validation with zod shared between server and
> form. Tests: time-window conversion across DST, privateSaleOpensAt computation. Commit.

---

## Phase 5 — Member app: discovery and redemption

**Goal:** the money path. Members find events and redeem.

**Port from EventOS:** ticket issuance, QR payload signing, ticket email/Wallet pass if EventOS has it.

**Prompt:**

> Phase 5. Implement `src/domain/redemption/redeem(memberId, offerId, { plusOneName? })` as ONE
> serializable transaction: lock the offer row FOR UPDATE, run every eligibility check in spec §7 in
> order and return a typed reason on failure, run `fraud.evaluate` (REVIEW → create HELD redemption that
> counts against capacity), for DISCOUNT_TICKET create a Stripe PaymentIntent for `face × (1 −
> discount%)` (+ plusOneCash) and only complete the redemption on `payment_intent.succeeded` (hold the
> capacity with a PENDING_PAYMENT state that expires after 10 minutes — add that status if needed),
> `spendKeys`, issue a Ticket using the EventOS QR signing scheme with a selfie snapshot, send the
> confirmation email. Implement `cancel(redemptionId)` honouring the 24h window (per-offer override →
> global setting), refunding keys via `refundKeys` and cash via Stripe refund. Waitlist for CAPPED
> offers: join, auto-notify next on cancellation with `waitlist_claim_minutes`, expire claims. Job
> `scripts/jobs/mark-no-shows.ts`: after `event.endsAt`, ACTIVE → NO_SHOW, update `AttendanceStats`,
> no refund. Member app screens: Home (this week in my city, filters, key-cost badge, "private sale"
> badge, "opens to your tier in Xh" copy), Event page, Redeem sheet (keys breakdown, +1 name, Stripe
> payment element for discounts), Tickets (list, QR full-screen, add to wallet), cancel with the cutoff
> clearly shown. Tests: invariants 3 (use 100 concurrent calls), 5, 6, 7, and HELD counts against
> capacity, PENDING_PAYMENT expiry releases capacity. Commit.

---

## Phase 6 — Scanner

**Port from EventOS:** the scanner app and QR verification, nearly verbatim.

**Prompt:**

> Phase 6. Port the EventOS scanner into `/scan`. Login with event scannerCode + PIN (rate-limited).
> Screen shows event, counters per offer (redeemed/scanned/remaining or window status/time left). Scan →
> verify signature → resolve ticket → result per spec §14, with the member selfie displayed large, name,
> +1 name, offer name. Write a `Scan` row on every attempt; on OK set redemption CHECKED_IN and update
> AttendanceStats.shows. TIME_WINDOW after `validUntil`: show WINDOW_CLOSED with PAY_DOOR or REFUSE per
> offer. Manual lookup by name. "Flag dispute" button with a note. Offline: cache the event's ticket
> list on login, queue scans, sync when online (port EventOS behaviour if present; otherwise implement
> simply). Tests: each ScanResult branch, double scan. Commit.

---

## Phase 7 — Referrals and partner claims (ELL bridge)

**Prompt:**

> Phase 7. Referrals: generate `referralCode` at signup; `/r/[code]` sets a cookie; on signup create
> `Referral(PENDING)`. Referrer must be on a paid non-tourist plan for the code to be active (show as
> inactive otherwise). Job `scripts/jobs/vest-referrals.ts` daily: VEST when invitee has a non-tourist
> subscription with `firstPaidAt` older than `referral_vesting_days` (setting, default 30) AND at least
> one CHECKED_IN redemption; then grant `referral_bonus_keys` to both as PURCHASED pool
> (`REFERRAL_BONUS`), respecting `referral_monthly_cap`; REJECT on self-referral, shared device
> fingerprint, or shared card fingerprint. Member app Referrals screen (code, share sheet, pending/vested
> list, keys earned). Partner claims: `PartnerCommunity` CRUD in backoffice (code, public key, promo
> JSON). Claim endpoint verifies an RS256 JWT with the community's public key, requires `exp`,
> `externalMemberId`, inserts `PartnerClaim` (unique → reject reuse), applies promo (grant a plan period
> without Stripe, or a Stripe coupon). Write `docs/PARTNER_TOKEN.md` describing the JWT contract so
> EventOS can implement the issuing side. Tests: invariants 8 and 9. Commit.

---

## Phase 8 — Settlements

**Prompt:**

> Phase 8. Job `scripts/jobs/settle-events.ts`: for each FINISHED event without a Settlement, build
> SettlementLines from tickets with a Scan result OK on DISCOUNT_TICKET offers: `owed = face × (1 −
> discount%)` (integer cents, round half up), sum into `Settlement(OPEN)`, email the producer a statement
> with CSV. Backoffice Settlements: per producer, open/paid, mark paid with reference, download CSV,
> re-send email. Dashboard tiles: open settlements total. Tests: invariant 10, rounding. Commit.

---

## Phase 9 — Notifications and jobs wiring

**Prompt:**

> Phase 9. Implement every email in spec §16 using the ported template system; schedule all jobs with
> Vercel Cron (`vercel.json`) protected by `CRON_SECRET`: monthly-grants (daily), expire-periods (hourly),
> mark-no-shows (hourly), vest-referrals (daily), settle-events (hourly), reconcile-balances (daily),
> purge-id-photos (daily), waitlist-claim-expiry (every 5 min), pending-payment-expiry (every 5 min).
> Event reminder email 25h before start mentioning the cancellation cutoff. Keys-expiring email 3 days
> before period end if plan keys > 0. Commit.

---

## Phase 10 — Polish, brand, PWA, legal, launch checklist

**Prompt:**

> Phase 10. Apply docs/BRAND.md tokens across the member app (dark theme default, red reserved for CTAs
> and the key/comma accents). PWA manifest + service worker (installable, offline ticket view). Apple/
> Google Wallet pass generation if EventOS has it, else defer. i18n scaffold with next-intl, `en` only.
> Legal pages: terms, privacy, cookie notice, auto-renewal and cancellation disclosure before checkout (EU
> consumer law), merchant-of-record note on discounted tickets, account deletion flow. Accessibility pass
> on the scanner (large targets, high contrast). Playwright e2e: signup → subscribe (Stripe test) →
> redeem free offer → scan OK; cancel outside/inside window. Write `docs/RUNBOOK.md`: env vars, Stripe
> webhook setup, cron, Neon branches, how to onboard a producer and an event, how to handle a fraud
> flag, how to settle. Commit.

---

## Phase 11 — EventOS partner API (producer connection, events, pricing)

**Prompt:**

> Phase 11. Read `docs/EVENTOS_INTEGRATION.md` and the contract in the EventOS repo
> `docs/SIAPP_API.md` (§1–3, §6). Schema: `ProducerApiKey` (producerId, prefix, keyHash sha256,
> createdById, createdAt, revokedAt, lastUsedAt; one active per producer), `Producer.eventosOrgId
> String? @unique`, `Producer.eventosWebhookUrl`, `Producer.eventosWebhookSecretHash` + previous +
> previousUntil, `Event.source MANUAL|EVENTOS` (default MANUAL), `Event.externalId` (unique per
> producer), `Event.snapshotVersion Int`, `Event.pausedAt`, `Offer.externalRef` (unique per event),
> `Offer.paymentMode SIAPP_COLLECTS|PRODUCER_COLLECTS` (default SIAPP_COLLECTS), `Offer.keyCostOverride
> Int?`, `PartnerIdempotency` (producerId, key, requestHash, response Json, createdAt; unique
> producer+key). Settings seeded: `key_value_cents` 100, `min_key_cost` 2, `guestlist_key_cost` 10,
> `key_cost_override_pct` 0, `min_discount_percent` 10, `max_discount_percent` 99,
> `partner_payment_hold_minutes` 15, `eventos_noshow_grace_hours` 6, `partner_photo_ttl_hours` 24,
> `partner_max_offers_per_event` 10. Domain `src/domain/partners-api/`: `keys.ts` (generate
> `siapp_pk_<8>_<32>`, hash, verify, revoke), `auth.ts` (`requireProducerKey(req)` → producer, stamps
> lastUsedAt, 401 codes), `idempotency.ts` (store/replay/mismatch 422), `pricing.ts` (pure contract
> §2.1 — the ONLY place key costs are computed; `keyCostOverride` wins), `snapshot.ts` (zod for
> `EventSnapshot`/`OfferSpec` exactly as contract §2.2/2.3 incl. 10–99 %, caps, frozen fields, deletion
> rule; `applySnapshot(producer, eventosEventId, snapshot)` = ONE tx: version guard 409, event upsert
> (cityId from producer, scanner creds minted on create via existing `createEvent` internals), offers
> upsert by `externalRef` → `OfferResult[]`), `status.ts` (publish via `setEventStatus`, pause =
> `pausedAt`, cancel = `refundEventRedemptions` keys-only for PRODUCER_COLLECTS), `sales.ts`
> (`RedemptionView[]` with `since`/cursor; `member.email` only when `cashCents > 0`), `errors.ts`.
> Routes `src/app/api/partner/v1/…`: connect, pricing, events/[id] PUT, events/[id]/{publish,pause,
> cancel}, events/[id]/sales, events/[id]/settlement (404 `no_settlement` for PRODUCER_COLLECTS),
> tickets/[id]/photo (query-signed, no-store). Rate limit 120/min per key (in-memory + `Setting`
> override). Eligibility/discovery: `pausedAt` hides the event from `/app` listings and refuses new
> redemptions (`RefusalReason` `event_paused`). Backoffice: producer page "EventOS connection" card
> (ADMIN: generate key → shown once, revoke, bound org, webhook URL); events with `source = EVENTOS`
> read-only ("Managed in EventOS by {producer}") except fraud/review, emergency cancel and the staff
> key-cost override. Tests `tests/partners-api.test.ts`: key verify/revoke, pricing table (€15 → 15,
> 40 % of €20 → 8, floor 2, guest list 10, override), snapshot validation codes, version guard,
> frozen-after-redemption, deletion-with-redemptions refused, publish/pause/cancel, sales filter +
> email rule, idempotency replay/mismatch, photo signature. Commit.

---

## Phase 12 — Outbound events, mirror tickets, external check-ins

**Prompt:**

> Phase 12. Contract §4.1, §4.3, §4.4, §4.5, §4.6, §3.7, §1.2. Schema: `OutboundEvent` (producerId,
> type, payload Json, status PENDING|SENT|FAILED, attempts, nextAttemptAt, lastError, sentAt;
> id = ULID used as the envelope id), `Ticket.externalTicketId`, `Ticket.externalOrderId`,
> `Scan.source` (SIAPP|EVENTOS) + `Scan.externalId` unique (eventosCheckInId). `src/domain/partners-api/
> outbox.ts`: `queueOutbound(producer, type, data)` + `flushOutbound()` (signs `t.body` HMAC with the
> producer's secret, POSTs to `eventosWebhookUrl`, backoff 1 m/5 m/15 m/1 h/6 h, 4xx ≠ 408/429 terminal,
> stores the response). Hooks: redemption → ACTIVE on a FULL/GUESTLIST offer of an EventOS event
> (redeem, releaseHeldRedemption, waitlist claim) → `redemption.activated` with a signed photo URL (ttl
> `partner_photo_ttl_hours` after endsAt) → on 200 store `externalTicketId/externalOrderId`;
> `cancelRedemption`/`denyHeldRedemption`/`refundEventRedemptions`/`expirePendingPayments` →
> `redemption.cancelled` with reason + `refundCash`; SIAPP scanner OK on an EventOS event →
> `ticket.checked_in`; every counter change → `sales.updated` coalesced 30 s per event; key revoked →
> `producer.disconnected`. Inbound `POST /redemptions/{id}/checkin` (`recordExternalCheckIn`: the OK
> branch of `processScan` as a conditional update, Scan row `source = EVENTOS`, `scannedBy =
> "eventos:{gate}"`, idempotent by `eventosCheckInId`, NO_SHOW → CHECKED_IN reversal within 48 h of
> endsAt with `noShows--`/`shows++`). `markNoShows`: EventOS events wait `eventos_noshow_grace_hours`.
> Member ticket page: "preparing for the door" until `externalTicketId` is set (FULL/GUESTLIST on
> EventOS events). Backoffice: event page shows outbound log (last 50) + failed rows with retry;
> scanner credentials card collapsed for EventOS events. Cron `pnpm jobs:partner-outbox` every minute
> via `CRON_JOBS`. Tests `tests/partners-outbound.test.ts`: activation payload + signature verifies
> with the test vector, retry/backoff/terminal, external check-in OK → ALREADY_SCANNED, no-show
> reversal window, cancellation reasons, coalesced sales.updated, disconnected on revoke. Commit.

---

## Phase 13 — Producer-collects payments

**Prompt:**

> Phase 13. Contract §4.2, §3.8, §5. For DISCOUNT_TICKET offers with `paymentMode =
> PRODUCER_COLLECTS`: `redeem()` still creates `PENDING_PAYMENT` with keys spent and the QR payload
> minted up front (`Ticket` row is NOT created yet — store `Redemption.qrPayload` new column);
> `startRedemptionPayment` becomes a dispatcher: SIAPP_COLLECTS → Stripe Checkout (unchanged),
> PRODUCER_COLLECTS → synchronous `order.create` to EventOS (signed, idempotent by redemption id,
> `holdMinutes` = `partner_payment_hold_minutes`, buyer = member name + email, +1 cash line) → store
> `Redemption.externalOrderId`/`externalPayUrl`, `paymentExpiresAt` = returned hold expiry → redirect
> the member to `payUrl`; `409 price_mismatch|sold_out|event_not_live` → cancel the redemption, keys
> back, friendly `?error=`. Inbound `POST /redemptions/{id}/payment`: `order.paid` → `completeExternalPayment`
> (PENDING_PAYMENT → ACTIVE conditional update, create `Ticket` with `qrPayload` = stored payload,
> `409 qr_mismatch` when the message's `ticket.qrToken` differs, `externalTicketId`, confirmation
> email, waitlist CLAIMED), `order.expired` → `expirePendingPayments` path for that one redemption,
> `refund.succeeded` → `Redemption.externalRefundedAt`, `refund.failed` → `externalRefundError` +
> OPEN note on the member page. `cancelRedemption` on a PRODUCER_COLLECTS redemption refunds keys and
> queues `redemption.cancelled refundCash = true` (no Stripe call). Settlement job skips
> PRODUCER_COLLECTS offers; `/admin/settlements` shows "collected by producer" where relevant. Member
> app: redeem sheet copy for producer-collects offers ("You pay {producer} on the next screen"; the MoR
> note names the producer, not us); ticket page "Pay now" uses `externalPayUrl`. Spec check: rules 6 and
> 10 in CLAUDE.md already describe this — code must match them. Tests `tests/partners-payments.test.ts`:
> dispatcher, order.create payload + idempotency, price_mismatch → keys back, order.paid → ACTIVE +
> ticket with the pre-minted payload, qr_mismatch 409, order.expired → EXPIRED + keys, cancel → keys +
> cancelled message, settlement skip, SIAPP_COLLECTS path untouched (existing redemption tests still
> green). Update CLAUDE.md build progress + `docs/BUILD_LOG.md`. Commit.

---

## Launch checklist (humans, not Claude Code)

- Final tier prices, key amounts, pack prices → DB + `sync-stripe-prices`
- Stripe live mode, Radar rules, Billing portal config, tax settings (VAT as merchant of record)
- New legal entity on Stripe; terms/privacy reviewed by counsel; auto-renewal wording checked for PT law
- Producer agreements: allocation terms, settlement cadence, no-show handling
- ELL token issuing endpoint shipped in EventOS; test a claim end to end
- Door staff trained on the scanner; printed fallback (name list) for the first nights
- Seed 2–3 weeks of events before opening signups

## Later (explicitly not now)

Partial late-cancel refunds and grace period (ledger already supports them), reputation-based access,
producer portal (comes from the EventOS clone), second city, push notifications, native apps, PT locale.
