# EventOS integration — SIAPP side

Status: **decided** (drafted 2026-11-04, all owner decisions taken 2026-11-08; contract written the same day
— EventOS `docs/SIAPP_API.md`; SIAPP build phases 11–13 in `docs/BUILD_PLAN.md`). The full architecture
note lives in the EventOS repo at `docs/SIAPP_Channel_Architecture.md` (read it first; this file only
lists what SIAPP has to provide and what changes here). Nothing is built yet; the decisions are in that
note's §13 and summarised in `docs/BUILD_LOG.md` ("EventOS integration — decisions").

## The idea in one paragraph

EventOS becomes a multi-tenant platform for producers. SIAPP is a **sales channel** a producer
switches on per event from a SIAPP tab in their EventOS dashboard: per ticket type they choose
Off / Full redemption / Discount (≥ 10 %, never full price) / Guest list, with caps. EventOS is the
producer portal the spec parked (§5, rule 10). SIAPP keeps owning members, keys, eligibility,
redemptions, fraud and the key economy. Tickets redeemed on SIAPP are mirrored into EventOS as real
tickets with the **same QR payload**, so the producer's EventOS scanner scans them natively and tells
SIAPP about the check-in; the SIAPP scanner keeps working too.

## What SIAPP must provide

1. **Producer connection** *(Phase 11, done)*. `Producer.eventosOrgId` (unique) + `ProducerApiKey` (hashed,
   prefix, revocable; one active per producer) generated from the producer page in the backoffice. The
   webhook secret is stored **encrypted** (SIAPP signs with it), previous secret valid 24 h after a rotation.
2. **Partner API** `/api/partner/v1/*` (bearer key): `connect`, `pricing`, `events/{id}` upsert +
   `publish|pause|cancel`, `events/{id}/sales`, `events/{id}/settlement`, signed `tickets/{id}/photo`
   *(Phase 11, done)*; `redemptions/{id}/checkin` (Phase 12), `redemptions/{id}/payment` (Phase 13). All
   validation of offers lives here (`src/domain/partners-api/snapshot.ts`).
3. **Pricing rule** in `Setting` *(Phase 11, done — `src/domain/partners-api/pricing.ts`)*:
   `key_value_cents` = **100** (€1 per key, owner 2026-11-08), `min_key_cost` 2, `guestlist_key_cost` 10,
   `key_cost_override_pct` 0, `min_discount_percent` 10, `max_discount_percent` 99 (+
   `partner_rate_limit_per_minute` 120).
   `keyCost = max(min_key_cost, ceil(value / key_value_cents))` where value = face (full) or
   face × d % (discount). Producers never set key costs; SIAPP staff may override one offer in the
   backoffice.
4. **Event/offer model additions** *(Phase 11, done)*. `Event.source MANUAL|EVENTOS`, `Event.externalId`,
   `Event.snapshotVersion`, `Event.pausedAt`; `Offer.externalRef` ("{eventId}:{ticketTypeId}:{mode}"),
   `Offer.paymentMode SIAPP_COLLECTS|PRODUCER_COLLECTS`, `Offer.keyCostOverride`; EventOS-sourced events
   read-only in the backoffice except fraud/review, emergency cancel and the staff key-cost override. The
   +1 on an EventOS offer costs the same keys as the member (same value, same rule).
5. **Outbox** (`OutboundEvent`: target, type, payload, attempts, nextAttemptAt, status) + job, for
   `redemption.activated`, `redemption.cancelled`, `ticket.checked_in`, `sales.updated` to EventOS,
   signed HMAC with the producer's webhook secret. SIAPP has no outbox today.
6. **Redemption changes.** `Redemption.externalOrderId/externalPayUrl`, `Ticket.externalTicketId`;
   `completeRedemptionPayment` generalised to `completeExternalPayment` (EventOS `order.paid` /
   `order.expired`) when the offer is `PRODUCER_COLLECTS`; the `order.create` command to EventOS
   replaces Stripe Checkout for those offers. Settlement job skips `PRODUCER_COLLECTS` events.
7. **Scanner / attendance.** `recordExternalCheckIn(redemptionId, at, gate)` = the OK branch of
   `processScan` (idempotent); `markNoShows` waits `eventos_noshow_grace_hours` (6) for EventOS
   events and a late check-in reverses NO_SHOW for 48 h (also closes `DECISIONS_PENDING` #2).
8. **Spec amendments** (done 2026-11-08 with decision A): `PRODUCT_SPEC.md` §5, §6, §12 and
   `CLAUDE.md` rules 6 and 10 now distinguish hand-managed producers (we collect, we settle) from
   EventOS producers (they collect through EventOS checkout, nothing to settle).

## What does not change

`redeem()` and its invariants (ledger, spend order, offer lock, fraud evaluation, 24 h window),
members, tiers, plans, referrals, partner claims, the SIAPP scanner, hand-managed producers and their
settlement flow.
