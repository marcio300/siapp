# EventOS integration — SIAPP side

Status: **draft for owner review** (2026-11-04). The full architecture note lives in the EventOS repo
at `docs/SIAPP_Channel_Architecture.md` (read it first; this file only lists what SIAPP has to provide
and what changes here). Nothing is built yet; decisions are in that note's §13.

## The idea in one paragraph

EventOS becomes a multi-tenant platform for producers. SIAPP is a **sales channel** a producer
switches on per event from a SIAPP tab in their EventOS dashboard: per ticket type they choose
Off / Full redemption / Discount (≥ 10 %, never full price) / Guest list, with caps. EventOS is the
producer portal the spec parked (§5, rule 10). SIAPP keeps owning members, keys, eligibility,
redemptions, fraud and the key economy. Tickets redeemed on SIAPP are mirrored into EventOS as real
tickets with the **same QR payload**, so the producer's EventOS scanner scans them natively and tells
SIAPP about the check-in; the SIAPP scanner keeps working too.

## What SIAPP must provide

1. **Producer connection.** `Producer.eventosOrgId` (unique) + `ProducerApiKey` (hashed, prefix,
   revocable; one active per producer) generated from the producer page in the backoffice.
2. **Partner API** `/api/partner/v1/*` (bearer key): `connect`, `pricing`, `events/{id}` upsert +
   `publish|pause|cancel`, `events/{id}/sales`, `events/{id}/settlement`, `redemptions/{id}/checkin`,
   `redemptions/{id}/payment`, signed `tickets/{id}/photo`. All validation of offers lives here.
3. **Pricing rule** in `Setting`: `key_value_cents`, `min_key_cost`, `guestlist_key_cost`,
   `key_cost_override_pct`, `min_discount_percent` (10). `keyCost = max(min, ceil(value / key_value))`
   where value = face (full) or face × d % (discount). Producers never set key costs freely.
4. **Event/offer model additions.** `Event.source MANUAL|EVENTOS`, `Event.externalId`,
   `Event.snapshotVersion`; `Offer.externalRef` ("{eventId}:{ticketTypeId}:{mode}"),
   `Offer.paymentMode SIAPP_COLLECTS|PRODUCER_COLLECTS`; EventOS-sourced events read-only in the
   backoffice except fraud/review and emergency cancel.
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
8. **Spec amendments** once decision A is taken: `PRODUCT_SPEC.md` §5, §6, §12 and `CLAUDE.md`
   rules 6 and 10 (the spec wins over code — amend first).

## What does not change

`redeem()` and its invariants (ledger, spend order, offer lock, fraud evaluation, 24 h window),
members, tiers, plans, referrals, partner claims, the SIAPP scanner, hand-managed producers and their
settlement flow.
