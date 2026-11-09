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
   *(Phase 11, done)*; `redemptions/{id}/checkin` *(Phase 12, done)*, `redemptions/{id}/payment` *(Phase 13,
   done)*. All
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
5. **Outbox** *(Phase 12, done — `src/domain/partners-api/outbox.ts` + `hooks.ts`)*: `OutboundEvent`
   rows (ULID = envelope id) for `redemption.activated` (FULL/GUESTLIST only), `redemption.cancelled`,
   `ticket.checked_in`, `sales.updated` (coalesced 30 s per event), `producer.disconnected`; signed
   `X-Siapp-Signature: t=…,v1=HMAC(secret, "t.body")`, backoff 1 m/5 m/15 m/1 h/6 h, terminal 4xx,
   cron `partner-outbox` every minute. EventOS's reply to `redemption.activated` fills
   `Ticket.externalTicketId/externalOrderId`.
6. **Redemption changes** *(Phase 13, done — `src/domain/partners-api/payments.ts`)*.
   `Redemption.qrPayload` (minted at redemption, EventOS adopts it as the ticket token),
   `externalOrderId/externalPayUrl/externalRefundedAt/externalRefundError`
   (`Ticket.externalTicketId/externalOrderId` landed in Phase 12). `startRedemptionPayment` is a
   dispatcher: SIAPP_COLLECTS → Stripe Checkout (unchanged), PRODUCER_COLLECTS → synchronous signed
   `order.create` to EventOS → the member pays on the producer's checkout; `POST
   /redemptions/{id}/payment` (`completeExternalPayment`) handles `order.paid` (ACTIVE + Ticket with the
   pre-minted payload, `409 qr_mismatch` otherwise), `order.expired`, `refund.succeeded|failed`.
   Settlement skips `PRODUCER_COLLECTS` offers (EventOS events settle as "collected by producer").
7. **Scanner / attendance** *(Phase 12, done — `src/domain/partners-api/checkin.ts`)*.
   `POST /redemptions/{id}/checkin` → `recordExternalCheckIn` = the OK branch of `processScan`
   (conditional flip, `shows++`, `Scan.source = EVENTOS`, idempotent by `eventosCheckInId`);
   `markNoShows` waits `eventos_noshow_grace_hours` (6) for EventOS events and a late check-in
   reverses NO_SHOW for 48 h (`noShows--`, `shows++`). Our scanner's OK on an EventOS event is
   reported back as `ticket.checked_in`.
8. **Spec amendments** (done 2026-11-08 with decision A): `PRODUCT_SPEC.md` §5, §6, §12 and
   `CLAUDE.md` rules 6 and 10 now distinguish hand-managed producers (we collect, we settle) from
   EventOS producers (they collect through EventOS checkout, nothing to settle).

## What does not change

`redeem()` and its invariants (ledger, spend order, offer lock, fraud evaluation, 24 h window),
members, tiers, plans, referrals, partner claims, the SIAPP scanner, hand-managed producers and their
settlement flow.
