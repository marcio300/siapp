# SIAPP Data Model

Draft schema in `prisma/schema.prisma`. This document explains the *why*; the schema is the *what*.
Port EventOS's `User`/auth tables and `Ticket`/QR structure where they fit; rename to this vocabulary.

## Core entities

```
City ─┬─ Producer ─── Event ─── Offer ─┬─ Redemption ─── Ticket ─── Scan
      │                                └─ WaitlistEntry
      └─ Member ─┬─ Subscription ─── (Stripe)
                 ├─ KeyTransaction  (ledger)
                 ├─ Redemption
                 ├─ Referral (as referrer / as invitee)
                 ├─ PartnerClaim (ELL etc.)
                 ├─ Device
                 └─ FraudFlag
Tier ─── Plan ─── (Stripe Price)
KeyPack ─── (Stripe Price)
Settlement ─── SettlementLine
Setting (global key/value)
StaffUser
```

## Design decisions

**Keys are a ledger.** `KeyTransaction(memberId, pool, type, amount, expiresAt?, redemptionId?, note)`.
`amount` is signed (grants +, spends −). Balance per pool = `SUM(amount)` over non-expired rows.
Plan grants carry `expiresAt` = period end; an `EXPIRY` row with the negative remainder is written by
the period-end job so history is explicit and sums stay exact. Maintain a cached `KeyBalance(memberId,
planKeys, purchasedKeys, planKeysExpireAt)` updated **in the same transaction** as every ledger write,
purely for reads; the ledger is the source of truth and a nightly job asserts they match.

**Spend attribution.** A redemption may draw from both pools. Store one `KeyTransaction` row per pool
touched (e.g. −20 PLAN, −5 PURCHASED), both linked to the redemption, so a refund is a mirror of those
rows. This is also what makes a future *partial* refund trivial.

**Allocation under concurrency.** `Offer.capacity` is fixed; count usage from `Redemption` rows with
status in (`PENDING_PAYMENT`, `HELD`, `ACTIVE`, `CHECKED_IN`). Redeem inside a serializable transaction after
`SELECT id FROM "Offer" WHERE id = $1 FOR UPDATE`. HELD (fraud review) counts against capacity so an
approved hold never oversells; a denied hold releases it.

**Redemption status machine.**
`PENDING_PAYMENT → ACTIVE | EXPIRED` (discounted tickets awaiting Stripe; expires after 10 min and
releases capacity); `HELD → ACTIVE | DENIED` (fraud review); `ACTIVE → CANCELLED | CHECKED_IN |
NO_SHOW`; `CHECKED_IN` is terminal. `NO_SHOW` is set by a job after `event.endsAt`. Only
`ACTIVE → CANCELLED` refunds keys/cash. Capacity counts `PENDING_PAYMENT + HELD + ACTIVE + CHECKED_IN`.

**Ticket vs Redemption.** Redemption is the economic record; Ticket is the scannable artefact (QR
payload, signature, plus-one name, photo snapshot URL). One redemption → one ticket. Keep them separate
so EventOS's ticket/scanner code ports with minimal change.

**Subscription.** Mirror Stripe: `Subscription(memberId, planId, stripeSubscriptionId, status,
currentPeriodStart/End, cancelAtPeriodEnd)`. Monthly key grants are driven by Stripe's
`invoice.paid` for monthly plans; for quarterly/yearly, a monthly job grants on each period anniversary
(store `nextGrantAt` on the subscription). Tourist pass is a `Subscription` with `planId = TOURIST_WEEK`,
no Stripe subscription, `currentPeriodEnd = purchase + 7d`.

**Referral vesting.** `Referral(referrerId, inviteeId, code, status: PENDING | VESTED | REJECTED,
vestedAt)`; a daily job checks the two vesting conditions and writes both `REFERRAL_BONUS` rows.

**Fraud.** `Device(memberId, fingerprint, firstSeen, lastSeen)` with an index on fingerprint;
`FraudFlag(memberId, redemptionId?, rule, evidence json, status: OPEN | APPROVED | DENIED, reviewedBy)`.

**Settlement.** `Settlement(producerId, eventId, status: OPEN | PAID, amountCents, paidAt, reference)`
with `SettlementLine(settlementId, ticketId, faceValueCents, discountPercent, owedCents)` generated from
`Scan`-confirmed discounted tickets only.

**Settings.** `Setting(key, value json)` for global defaults: `cancellation_window_hours=24`,
`waitlist_claim_minutes=60`, `overlap_tolerance_hours=3`, `referral_bonus_keys=10`,
`referral_monthly_cap=20`, `referral_vesting_days=30`, `velocity_first_hour_max=3`,
`device_max_accounts=3`, `pending_payment_minutes=10`.

**Multi-city.** `cityId` on City-scoped rows; `Plan` has `PlanPrice(planId, cityId, currency,
amountCents, stripePriceId)` so prices can differ per city later.

## Invariants to test (Vitest, against a real Postgres via Neon branch or docker)

1. Balance never negative; redemption with insufficient keys is rejected.
2. Plan pool is debited before purchased pool; refund restores exactly the debited rows.
3. 100 concurrent redemptions on a capacity-10 offer yield exactly 10 ACTIVE.
4. Expiry job zeroes plan pool at period end and never touches purchased pool.
5. Private sale: non-eligible tier rejected before `opensAt`, accepted after.
6. Cancellation at 24h+1min succeeds; at 24h−1min is rejected.
7. NO_SHOW job forfeits keys and writes no refund row.
8. Referral bonus not granted before vesting conditions; granted once, never twice.
9. PartnerClaim token cannot be claimed twice.
10. Settlement amount equals Σ over *scanned* discounted tickets only.
11. Stripe webhook replay is a no-op.
