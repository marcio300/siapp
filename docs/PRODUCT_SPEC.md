# SIAPP Product Spec — v1 (launch scope)

Status: agreed 2026-10-27. This is the reference for the build. Numbers marked *placeholder* are to be
tuned before launch and must live in the database, not in code.

## 1. What it is

"Sorry, it's a private party" is a membership club. Members subscribe, receive **keys** every billing
period, and spend keys to get into partner events for free or at a discount. Producers in Lisbon
currently need audiences and give away large allocations (200–1000 tickets per event, unlimited club
entry before a cutoff hour) to selected partners; the club turns that inventory into a subscription.

Launch city: Lisbon. Audience: Portuguese and international residents aged 24+, plus a summer weekly
pass for tourists. Erasmus Life Lisboa (ELL) members are one acquisition channel, not the audience.

Launch surfaces:

1. **Member web app** (mobile-first PWA): discover events, redeem, wallet, membership, referrals, tickets.
2. **Backoffice** (staff): producers, events, offers, members, fraud queue, settlements, plans, settings.
3. **Scanner web app** (door staff / producer door): scan tickets for one event, see photo, mark entry.

No producer portal, no native apps.

## 2. Keys (the credit unit)

- Name in UI: **keys**. Symbol: key icon. Never "credits" in copy.
- Abstract unit; not pegged to euros. Base scale: a regular club guest list costs about **10 keys**,
  a big event about **50 keys** (*placeholders*; per-offer values set in backoffice).
- Two pools per member:
  - **Plan keys**: granted at the start of each billing period according to the tier. Expire at period
    end (unused keys are lost). Spent first.
  - **Purchased keys**: bought in packs. Never expire. Spent after plan keys are exhausted.
- Wallet shows both pools separately with the plan-key expiry date.
- Balance is derived from an append-only ledger (`KeyTransaction`). Transaction types:
  `PLAN_GRANT`, `PACK_PURCHASE`, `REDEMPTION`, `CANCELLATION_REFUND`, `REFERRAL_BONUS`, `EXPIRY`,
  `ADMIN_ADJUSTMENT`, `PROMO_GRANT`.
- Quarterly and yearly plans still grant keys **monthly** (a yearly member gets 12 monthly grants, each
  expiring after its month). This keeps the "use it or lose it" behaviour uniform.

## 3. Membership tiers and plans

Tiers (config in DB; names final, numbers *placeholder*):

| Tier | Monthly price | Keys / month | Extras |
|---|---|---|---|
| FREE | €0 | 0–2 | See full calendar; access only to offers flagged `openToFree`. |
| SOCIAL | ~€15 | ~30 | — |
| REGULAR | ~€30 | ~80 | Expected volume tier. |
| PLUS | ~€50 | ~150 | Eligible for private-sale windows by default; +1 allowed by default where the offer permits. |

Billing periods: monthly, quarterly (~10% off), yearly (~2 months free). Each tier × period is a Stripe
Price. Upgrades prorate via Stripe; the key grant for the new tier applies from the next period
(simplest, avoids gaming — can revisit).

**Tourist weekly pass** (`TOURIST_WEEK`): ~€25, ~50 keys, valid 7 days from purchase, no renewal,
ID photo required at purchase, counts as a paid membership for the duration (not for referral purposes).

**Key packs**: e.g. 20 keys / €8, 50 keys / €18 (*placeholders*). Priced so that per-key cost is always
above the REGULAR tier's per-key cost — topping up must never be cheaper than upgrading. Available to
any paid tier; FREE members cannot buy packs (forces a conversion).

Pricing anchor for tuning: a standard club night should feel like €3–4 on REGULAR; a member going out
twice a week on PLUS must clearly save money versus door prices.

## 4. Cities

Every producer, event, plan price, and member (home city) carries a `cityId`. City holds name, country,
timezone, currency, and `isActive`. Only Lisbon is seeded. The member app is scoped to the member's
selected city; backoffice has a city switcher. No Lisbon-specific logic anywhere in code.

## 5. Producers

A producer is a club, promoter or festival. At launch producers **do not log in**. Backoffice staff
create and manage producers and their events. Producers receive:

- a **scanner login** per event (short code + PIN, or a magic link) valid for the event window;
- a **settlement report by email** after each event with discounted-ticket revenue collected.

Producer record also stores: contact, IBAN/payout details (for settlements), default discount terms,
whether they use EventOS (future: direct integration).

## 6. Events and offers

An **event** has: producer, city, venue, title, description, images, start/end datetime, status
(`DRAFT`, `PUBLISHED`, `CANCELLED`, `FINISHED`), tags, and 1..n **offers**.

An **offer** is what a member can redeem. Fields:

- `type`: `FREE_TICKET`, `DISCOUNT_TICKET`, `GUESTLIST`
- `keyCost` (integer keys)
- `faceValueCents` and `discountPercent` (DISCOUNT_TICKET only; member pays `face × (1 − d%)` in cash
  **to us**, we settle with the producer)
- `allocationType`: `CAPPED` (with `capacity`) or `TIME_WINDOW` (with `validUntil` time, e.g. 02:00;
  guest-list style, unlimited count)
- `afterWindowBehaviour` (TIME_WINDOW only): `REFUSE` or `PAY_DOOR` (scanner shows "window closed,
  door price applies"; we don't collect that money)
- `privateSale`: optional `{ tiers: [...], hoursBefore: 24 | 48 }` — only those tiers can redeem until
  `opensAt = publishedAt + hoursBefore` (set explicitly per offer in backoffice)
- `openToFree`: whether FREE tier can redeem (default false)
- `plusOne`: `{ allowed: boolean, extraKeyCost: integer, extraCashCents?: integer }`
- `cancellationWindowHours`: default from global setting (24), overridable per offer
- `maxPerMember`: default 1
- `redeemFrom` / `redeemUntil`: redemption availability window (defaults: publish → event start)

Examples that must both work on one event: "Early entrance, FREE_TICKET, 25 keys, capacity 300,
private sale PLUS 48h" and "Standard, DISCOUNT_TICKET 40% off €20, 10 keys, no cap, all paid tiers".

## 7. Redemption

Flow: member taps Redeem → eligibility check → (if DISCOUNT_TICKET) Stripe payment → keys debited →
ticket issued → confirmation + wallet pass/email.

Eligibility (all must pass, evaluated server-side in one transaction with the offer row locked):

1. Member is verified (email verified, age attested, selfie on file).
2. Member's tier is allowed (private-sale window, `openToFree`).
3. Offer is open (`redeemFrom ≤ now ≤ redeemUntil`, event published).
4. Capacity remains (CAPPED) — counted as `redemptions where status in (ACTIVE, CHECKED_IN)`.
5. Member has enough keys (plan + purchased), and `maxPerMember` not exceeded.
6. No overlapping active redemption for another event in the same time slot (anti-sharing rule:
   configurable overlap tolerance, default: events whose start times are within 3 hours).
7. Fraud checks (section 10) return `ALLOW` or `REVIEW` (REVIEW creates a held redemption).

Debit order: plan keys first, then purchased keys. Record which pool(s) were debited (for refunds).

**Ticket**: same QR format and signing as EventOS so the scanner is a port. Ticket carries member
name, photo URL, event, offer, +1 name if any, and status.

**Waitlist** (CAPPED offers only): when full, members can join a waitlist; on cancellation the next
member is notified and has a short claim window (setting, default 60 min) before the spot passes on.

## 8. Cancellation and no-shows

- Members may cancel a redemption up to **24 hours before event start** (global setting; per-offer
  override). Keys are refunded in full to the pools they came from; discounted-ticket cash is refunded
  via Stripe.
- Inside 24h: no cancellation. If the ticket is never scanned, the redemption becomes `NO_SHOW` after
  the event ends and keys are forfeited. Cash paid for a discounted ticket is **not** refunded.
- Record every no-show on the member (`attendanceStats`). Not used to gate anything yet.
- **Not built now** (but ledger supports it): grace period after redemption, partial late-cancel refund.

## 9. Referrals (member-get-member)

- Every **paid** member gets a referral code / link. FREE members can see the feature but their code is
  inactive until they pay.
- When a referred user signs up and becomes a paid member, both referrer and invitee receive **10 keys**
  (`REFERRAL_BONUS`, granted as purchased-pool keys so they don't expire) — but only when the bonus
  **vests**: the invitee's first paid period has passed the Stripe refund/dispute window **and** the
  invitee has at least one `CHECKED_IN` ticket.
- Referral is recorded at signup (cookie + code), vests via a daily job. Caps: max 20 vested referrals
  per referrer per month (setting). Self-referral, same payment method, same device fingerprint → flagged.
- Tourist weekly pass does not count as a paid membership for referral vesting.

## 10. Identity and fraud

Launch controls:

- Email verification required (magic link); disposable-email domain blocklist; one account per email.
- Age gate: explicit attestation of 24+ at signup; date of birth stored; tourists must upload an ID photo
  (stored encrypted, reviewed in backoffice, deleted after 30 days).
- **Selfie required before first redemption**; shown large on the scanner screen for every scan.
- Device fingerprint on login (e.g. FingerprintJS open-source); >3 accounts on one fingerprint → REVIEW.
- Velocity rules: a new account redeeming more than N offers in its first hour, or more than one
  private-sale offer in its first day → REVIEW (held redemption, staff approves/denies in fraud queue).
- Overlap rule (section 7).
- Payment: Stripe Radar on; same card across many accounts → flag.
- Per-member attendance stats (shows, no-shows, door disputes) recorded for future reputation scoring.

Backoffice fraud queue: list of REVIEW items with the evidence, one-click approve/deny/ban.

## 11. ELL bridge (and other partner communities)

No shared database. EventOS issues a signed, single-use **claim token** (JWT: `source=ELL`,
`externalMemberId`, `name`, `exp` ~ 7 days). The member enters/taps it during SIAPP signup or in
Membership settings. SIAPP verifies the signature with the partner's public key, stores
`PartnerClaim(source, externalMemberId)` with a unique constraint so a token can never be reused, and
applies the configured promo (e.g. free SOCIAL for 3 months, or X% off). The same mechanism serves any
future partner community; partner keys and promo rules are configured in backoffice.

## 12. Settlement

For DISCOUNT_TICKET offers we collect the member's cash. After each event ends, a job computes per
producer per event: `scanned discounted tickets × face × (1 − discount%)` = amount owed. Backoffice
shows a settlement ledger per producer (open, paid, with payment reference); staff marks paid. Producer
receives an email with the statement (CSV attached). FREE_TICKET and GUESTLIST offers settle nothing.

## 13. Backoffice (staff)

Modules: Dashboard (redemptions, actives, revenue, no-show rate), Producers, Events & Offers (with
preview and duplicate), Members (search, wallet, ledger, tickets, attendance, manual adjustments with
reason), Fraud queue, Referrals, Plans & key packs (prices synced to Stripe), Settlements, Settings
(global defaults), Cities, Partner communities, Staff users & roles (`ADMIN`, `OPS`, `DOOR`).

## 14. Scanner

Mobile web app. Login with event scanner code + PIN. Shows event, counts (redeemed / scanned / remaining
for CAPPED, window status for TIME_WINDOW). Scan QR → big photo, name, +1 name, offer, result:
`OK`, `ALREADY_SCANNED`, `WINDOW_CLOSED (PAY_DOOR / REFUSE)`, `CANCELLED`, `INVALID`. Works offline for
reads with a periodically refreshed ticket list and queues scans (port EventOS behaviour if it has it).
Manual search by name as fallback. Door staff can flag a dispute on a ticket (feeds attendance stats).

## 15. Member app — screens

Onboarding (email, name, DOB + 24+ attestation, city, optional referral code / ELL token) → Choose plan
(FREE default) → Selfie → Home (this week in your city, filters by day/area/type, key cost badges, private
sale badges) → Event page (offers, eligibility explained in plain language: "opens to your tier in 23h")
→ Redeem (confirm keys, +1 name, Stripe sheet for discounts) → Tickets (wallet, QR, add to Apple/Google
Wallet) → Wallet (plan keys with expiry, purchased keys, buy packs, ledger) → Membership (tier, period,
upgrade, cancel, tourist pass) → Referrals (code, share, pending/vested) → Profile (selfie, email,
city, delete account).

Copy tone: dry, confident, a little cheeky. The brand line is the door's "sorry…" and the key is the
answer to it.

## 16. Emails / notifications

Verify email, welcome, plan keys granted, keys expiring in 3 days, redemption confirmation (with ticket),
cancellation confirmation, event reminder (day before, with the 24h cutoff reminder), no-show notice,
referral vested, subscription renewal / failed payment (Stripe), tourist pass expiring, producer
settlement statement. Push via PWA later.

## 17. Open items (decide before launch, not blocking build)

Final tier prices and key amounts; FREE tier 0 vs 2 keys; exact velocity thresholds; overlap tolerance;
legal copy (terms, privacy, auto-renewal notice per PT/EU consumer law, VAT handling as merchant of record).
