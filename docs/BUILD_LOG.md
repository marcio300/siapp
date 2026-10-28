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

## Phase 3 — Identity, onboarding, fraud foundation (2026-10-28)

**Shipped**

- Onboarding at `/app/onboarding`: name, date of birth (day/month/year selects), explicit 24+ attestation,
  home city (active cities only), optional referral code (prefilled from the `/r/[code]` link cookie),
  optional partner claim token. Under-24 is rejected server-side ("Sorry, it's a 24+ party."). Every
  member page is gated until the profile is complete.
- Referral links: `/r/CODE` stores the code in a cookie for 30 days; onboarding records a PENDING
  `Referral` (vesting is Phase 7). Own code and unknown codes are reported, not recorded.
- Disposable email domains: vendored community list (~10k domains, subdomain-aware), checked on the
  sign-in page (friendly message) and enforced in the NextAuth callback. Refresh with
  `pnpm fraud:update-disposable-domains`.
- Profile at `/app/profile`: selfie (camera on mobile, upload fallback) and tourist ID photo. Selfie is
  required before the first redemption and shows on the scanner; ID photo is **AES-256-GCM encrypted at
  rest**, viewable only through a staff route, required to buy the tourist pass, purged after 30 days
  (`pnpm jobs:purge-id-photos`). Media storage adapter ported from EventOS (Vercel Blob / local disk).
- Device fingerprint (open-source FingerprintJS) on every member page load, once per tab session →
  `Device` upsert; more than `device_max_accounts` accounts on one fingerprint flags the member.
- `src/domain/fraud/evaluate(memberId, offerId)` → ALLOW | REVIEW with rules DEVICE_MAX_ACCOUNTS,
  VELOCITY_FIRST_HOUR, VELOCITY_PRIVATE_SALE, OVERLAP (events starting within
  `overlap_tolerance_hours`), SAME_CARD (Stripe card fingerprint across accounts, captured from
  `charge.succeeded`). Every fired rule writes an OPEN `FraudFlag` with evidence; one open flag per
  (member, rule, redemption).
- Backoffice: Fraud queue (open/reviewed, evidence, approve/deny with note, ban with reason), member
  page gained identity card (selfie, verification badges, DOB/attestation), ID photo viewer,
  attendance stats, devices with "shared with", flags with inline review, ban/lift ban (ADMIN).
- Tests: 14 identity + fraud checks (57 total): disposable matching, age edge cases, onboarding
  rules/referral/partner token, encryption round trip, selfie replace, ID photo encrypt/read/gate/purge,
  each fraud rule positive and negative, card webhook, review/ban lifecycle.

**Decisions**

- The member row exists before onboarding (magic link), so `onboardedAt` is the gate, not `cityId`.
- **OVERLAP is a hard refusal** (owner, 2026-10-28): a live redemption for another event starting
  within `overlap_tolerance_hours` (3 h) of this one makes `evaluate` return REJECT with the reason and
  writes no flag; events further apart are allowed. Phase 5 shows the reason on the redeem screen.
- **One approval releases everything** (owner, 2026-10-28): approving any flag on a HELD redemption
  releases it and closes the redemption's other open flags as APPROVED (noted "approved with …");
  denying any flag denies the redemption. Refunding keys of a DENIED redemption is Phase 5's.
- Banning closes all open flags as DENIED, denies HELD redemptions, kills sessions and blocks sign-in.
- Partner claim tokens are stored raw on the member (shape-checked only); Phase 7 verifies and consumes
  (owner, 2026-10-28: keep as built; don't open signups to ELL members before Phase 7 is live, tokens
  expire in ~7 days).
- ID photos are served decrypted through `/api/admin/id-photo/[memberId]` (OPS+), never cached. Key from
  `ID_PHOTO_KEY` (required in production); dev derives one from `AUTH_SECRET`.
- Two new settings: `velocity_private_sale_first_day_max` (1) and `same_card_max_accounts` (1).

**Spec deviations**

- None. Fingerprint library: FingerprintJS v5 is MIT again, so it's the open-source choice.

**Open**

- Account deletion flow (Phase 10). Emails (Phase 9). Velocity thresholds are placeholders (spec §17).

**Gotchas**

- A server component cannot set cookies in Next 15 — the referral landing is a route handler.
- Headless browsers share one fingerprint, so repeated local test runs trip the shared-device rule on
  purpose-built test accounts; that's the rule working, not a bug.

## Phase 4 — Producers, events, offers (backoffice) (2026-10-28)

**Shipped**

- Producers (`/admin/producers`): list with search, create, edit; contact, default discount %,
  "uses EventOS" flag, notes; payout details (IBAN) encrypted at rest, shown masked, revealed or
  cleared by ADMIN only. A producer with events can't change city.
- Events (`/admin/events`): list with city / status / date-range filters (upcoming by default, "include
  past"), per-offer counters (redeemed / capacity, or redeemed · until HH:MM for windows); create
  (draft) with the producer setting the city and local wall-clock start/end converted to UTC; edit;
  publish / unpublish / cancel / finish; duplicate (structural copy as draft, dates shifted by N days,
  new scanner credentials); scanner code + PIN generated on create and shown once (PIN stored as a
  scrypt hash), regenerate PIN.
- Offers nested on the event page, every spec §6 field: type, key cost, face value + discount %,
  CAPPED capacity or TIME_WINDOW "until 02:00" (stored as the absolute UTC instant of the next 02:00
  after the event starts, in the city timezone) with REFUSE / PAY_DOOR, private sale (tier
  multi-select + 24/48 h → `privateSaleOpensAt = publishedAt + hours`, computed on publish or at once
  for offers added after publishing, editable with an explicit date/time), open to FREE, +1 (allowed,
  extra keys, extra cash), cancellation window override, max per member, redeem window, sort order.
- Zod schemas in `src/domain/events/schemas.ts` are shared by the server actions and the forms.
- Timezone helpers (`src/lib/time.ts`, no dependency): local → UTC across DST (spring gap resolves
  after the jump, autumn overlap to the first occurrence), UTC → local, window-until.
- Tests: 11 new (68 total): DST both ways, round trips, guest-list windows in summer/winter/on the
  switch night, producer CRUD + encryption + masking, event creation/UTC/scanner/PIN, offer validation
  per type/allocation, private-sale computation on publish (once, explicit value preserved, offers
  added later), status transitions, counters, frozen economics, delete guard, duplicate.

**Decisions**

- Status flow: DRAFT → PUBLISHED ⇄ DRAFT (unpublish), PUBLISHED → CANCELLED | FINISHED; closed events
  are frozen. Publishing requires at least one offer. `publishedAt` is stamped once and survives
  unpublish/republish, so private-sale windows don't move.
- Once an offer has live redemptions its type, key cost and price are frozen (add a new offer
  instead) and capacity can't drop below what's redeemed. Deleting needs zero redemptions.
- Cancelling an event is status-only here; refunds hook in with Phase 5 and settlement with Phase 8.
- Images are URLs (one per line) for now; uploads via the media adapter can come with the member app.
- `DATA_ENCRYPTION_KEY` replaces `ID_PHOTO_KEY` as the at-rest key name (old name still accepted).
- The scanner login (`authenticateScanner(code, pin)`) is already in the domain for Phase 6.

**Spec deviations**

- None.

**Open**

- No image upload yet. No event-level "duplicate with offers unchanged but no shift" button (shift 0
  does that). Scanner UI is Phase 6.

**Gotchas**

- Redirect URLs must put the query before the hash (`?error=…#offers`); the other way round the
  server never sees the parameter.
- Browser tests that wait for a URL already matching the current one resolve immediately; navigate
  to a clean URL before each submission.

## Phase 5 — Member app: discovery and redemption (2026-10-28)

**Shipped**

- `src/domain/redemption`: `redeem(memberId, offerId, { plusOneName })` in ONE transaction that locks
  the offer row (`SELECT … FOR UPDATE`), runs the spec §7 checks in order with fresh counts, runs
  `fraud.evaluate`, spends the keys (the ledger joins the transaction), creates the redemption and,
  when immediately ACTIVE, its ticket. Outcomes: ACTIVE (ticket + email), PENDING_PAYMENT (cash due:
  Stripe Checkout, the webhook completes it, hold expires after `pending_payment_minutes`), HELD
  (fraud review; counts against capacity). Typed refusal reasons feed plain-language copy.
- Tickets in the EventOS format: an opaque 32-hex QR token resolved server-side, plus a stored HMAC
  signature for Phase 6's offline mode; member name, selfie snapshot, +1 name.
- Cancellation honouring the window (per-offer override → global 24 h): keys back to their pools,
  cash refunded through Stripe, seat offered to the waitlist. Pending and held tickets cancel any time.
- Waitlist on capped offers: join when full, the first in line is notified when a seat frees and holds
  a reservation for `waitlist_claim_minutes` (others see "reserved for the waitlist"), expiry passes the
  seat on. Redeeming while notified claims it.
- Jobs: `mark-no-shows` (hourly: ACTIVE → NO_SHOW after the event ends, attendance updated, no refund,
  event FINISHED), `expire-pending-payments` (5 min), `expire-waitlist-claims` (5 min).
- Event cancellation in the backoffice now refunds every live redemption (keys + cash) and closes the
  waitlist. Fraud review approve/deny now releases (ticket) or denies (keys back) held redemptions.
- Member app: home "this week in your city" (day / type / tag chips, key-cost badge, private-sale
  badge, "opens to your tier in Xh"), event page (per-offer eligibility explained, +1 info, waitlist
  join/leave), redeem sheet (plan vs purchased breakdown, +1 name, price, cutoff), tickets list and
  ticket page (full-screen QR on white, selfie, cancel with the cutoff shown, pay button for pending,
  review notice for held). Backoffice: redemptions table on the event page, tickets on the member page.
- Tests: 11 new (79 total): invariant 3 with 100 concurrent calls (exactly 10 win, 90 keep their
  keys), 5 (private sale before/after opensAt), 6 (24 h ± 1 min), 7 (no-show forfeits), HELD counts
  against capacity, PENDING_PAYMENT expiry releases the seat, discounted flow through the webhook with
  replay and late-payment refund, overlap refusal, waitlist hand-off and expiry, event cancellation.

**Decisions**

- **Keys are debited at creation for every outcome** (pending, held, active) so the same keys can't be
  spent twice while a payment or review is open; expiry and denial refund them. The spec's prose order
  ("payment → keys → ticket") is kept for the member, the ledger just moves first.
- **Discounted tickets pay through Stripe Checkout**, not a Payment Element: same webhook-only
  fulfilment as plans and packs, no client-side Stripe.js or publishable key yet. The build plan said
  "payment element"; CLAUDE.md allows Checkout. Swap later if the redirect hurts conversion.
- The transaction runs READ COMMITTED with the row lock, not SERIALIZABLE: the lock is what serialises
  members, and SERIALIZABLE only added spurious aborts for those queued behind it.
- Every read inside the redemption transaction goes through the transaction client, settings
  included. Using the global client inside a held transaction needs a second pool connection, and
  under a burst that deadlocks the pool (found by the 100-concurrent test).
- A HELD redemption with cash due becomes PENDING_PAYMENT on approval with a 24 h window (not 10 min),
  since the member wasn't waiting at the screen.
- Money arriving for an already expired/denied redemption is refunded automatically.
- Waitlist joins require an eligible, verified member; verification is checked before everything else
  (so an unverified member sees "add a selfie first", not the waitlist).
- No Apple/Google Wallet pass: EventOS has none to port (Phase 10 decides).

**Spec deviations**

- Payment Element → Checkout (above).

**Open**

- Emails here are confirmation, cancellation and waitlist spot only; reminders and the rest are Phase 9.
- `/app` home shows 7 days; "area" filter from spec §15 needs venue areas that don't exist yet.

**Gotchas**

- In dev, every test account shares the headless browser's fingerprint, so the shared-device rule
  flags demo accounts into review; raise `device_max_accounts` in the dev settings when demoing.
- Redirect responses in tests: a `waitForURL` that already matches resolves at once — navigate to a
  clean URL before submitting.

## Phase 6 — Scanner (2026-10-28)

**Shipped**

- `/scan` door app, ported from EventOS's `scanner-client` and extended per spec §14. Login with the
  event's scanner code + PIN and an optional door label ("Main door"); the session is a signed,
  httpOnly cookie valid until 12 h after the event ends. Wrong PINs are rate-limited per code: 5 in a
  row lock the code for 15 minutes (`Event.scannerFailedLogins/scannerLockedUntil`).
- `src/domain/scanner`: `processScan` resolves the QR token, re-checks the stored HMAC signature, then
  returns OK / ALREADY_SCANNED / WINDOW_CLOSED (PAY_DOOR or REFUSE) / CANCELLED / INVALID with the
  ticket card (selfie, name, +1, offer). Every attempt writes a `Scan` row (unknown codes keep the raw
  payload). OK flips ACTIVE → CHECKED_IN with a conditional `updateMany` inside a transaction, so two
  doors scanning the same QR at once get exactly one OK, and bumps `AttendanceStats.shows`.
  `scannerSummary` (per-offer redeemed / scanned / remaining or window status + minutes left),
  `searchTickets` (name, +1 or email), `flagDispute` (note on the scan, `AttendanceStats.disputes`
  once per scan), `ticketManifest` + `syncScans` for offline mode.
- Scanner UI (light theme, result floods the card green / amber / red): counters header, camera via
  the native BarcodeDetector with a `jsqr` fallback for browsers without it (Safari), manual code
  entry, name search with a "Scan" button per hit, "Paid at the door — admit" after WINDOW_CLOSED on
  PAY_DOOR offers, "Flag dispute" with a note, sign out.
- Offline: the ticket list (every ticket with its status, photo URL and offer window) is cached in
  localStorage at login and refreshed every 45 s. With no connection, reads resolve against the cache
  (provisional OK / already scanned / cancelled / window closed), get queued with the device
  timestamp, and replay through `POST /api/scan/sync` when the browser comes back online. The server
  keeps the device timestamp for `checkedInAt` when it is plausible (≥ 24 h before the event start,
  not in the future). Replays whose result differs from what the door saw (e.g. ALREADY_SCANNED
  because another door got there first) show up in a "sync surprises" panel. Disputes flagged offline
  ride along with the queued scan.
- Backoffice event page: "Open scanner" link, checked-in / disputed counts on the scanner card, and a
  "Door log" table (last 100 scans: time, result, ticket, door, dispute note).
- Tests: 10 new (89 total): login + lockout + token verification, OK with stats and device, double
  scan, four concurrent scans → one OK, every INVALID path (unknown, tampered signature, wrong event,
  unpaid, under review), every CANCELLED reason, WINDOW_CLOSED for REFUSE and PAY_DOOR + admit,
  counters, lookup, dispute idempotency, manifest + ordered sync with timestamps and an attached note.

**Decisions**

- The scanner session is stateless (HMAC token, no DB row) and per event, matching "producers get a
  scanner login per event" — there is no door identity beyond the label typed at login, which is
  stored as `Scan.scannedBy`. Staff use the same code + PIN (the code sits on the event page).
- Spec §14 lists five results; "wrong event", "not paid yet" and "under review" are INVALID with an
  explicit message rather than new enum values.
- PAY_DOOR after the window: the first scan only reports WINDOW_CLOSED; admission (and the check-in)
  is an explicit second tap by the door, so a guest who walks away isn't marked as a show.
- EventOS has no offline mode to port, so this one is deliberately simple: cache + queue + replay, with
  the server as the only source of truth. No client-side signature verification (that would ship the
  secret); an unknown code offline is "unverified" and left to the sync.
- Offline photos depend on the browser's HTTP cache — the manifest carries URLs, not image bytes.

**Open**

- No PWA shell yet (Phase 10): the scanner works offline inside an open tab, but a cold load without
  network still needs the app shell cached by a service worker.
- Dispute flags only feed `AttendanceStats.disputes`; nothing acts on the count (by design — out of
  scope: reputation effects on access).
- `DOOR` staff role exists but has no screen of its own; it can open `/admin` read-only and `/scan`
  with the event credentials.

## Phase 7 — Referrals and partner claims (ELL bridge) (2026-10-28)

**Shipped**

- `src/domain/referrals`: `referralOverview` (code, link `/r/{code}`, active flag, counts, keys
  earned, the list with invitees shown as "First L."), `vestReferral` / `vestReferrals` (the daily
  job, `pnpm jobs:vest-referrals`). Vesting order: hard rejections first (self-referral, shared
  device fingerprint, shared card fingerprint → REJECTED + an OPEN `SELF_REFERRAL` fraud flag with
  the evidence), then the invitee's first paid non-tourist period must be older than
  `referral_vesting_days`, the invitee must have a CHECKED_IN redemption, the referrer must still be
  on a paid non-tourist plan, and the referrer must be under `referral_monthly_cap` vested this
  calendar month — otherwise it stays PENDING with a reason. Vesting flips PENDING → VESTED with a
  conditional update and grants `referral_bonus_keys` to both sides as PURCHASED keys with
  references `referral:{id}:referrer|invitee`, so it can never pay twice. Both get an email.
- Onboarding now records a referral only when the referrer's code is active (paid, non-tourist);
  otherwise the member sees "that code isn't active right now".
- Member app `/app/referrals` ("Invite" tab): code, link, native share sheet with clipboard fallback,
  pending / vested / keys-earned tiles, the list with status, and where the member came from.
- `src/domain/partners`: RS256 claim-token verification with `node:crypto` (no JWT library; only
  RS256, required `source`/`externalMemberId`/`exp`, 60 s skew), `claimPartnerToken` (community by
  `source`, signature, expiry, one claim per member per community, unique `(community,
  externalMemberId)` and `jti` → "already used"; claim row + promo + token clean-up in one
  transaction, so a failed promo leaves no claim), `claimStoredToken` for the token typed at
  onboarding, community CRUD with PEM + promo validation. Promo kinds: `PLAN_PERIOD` (a paid tier
  for N months without Stripe — new `startPromoPeriod` in billing, monthly key grants via
  `nextGrantAt`, back to FREE at the end through `runExpirePeriods`), `KEYS` (purchased keys,
  `PROMO_GRANT`), `STRIPE_COUPON` (applied to the live Stripe subscription).
- Onboarding tries the claim immediately and reports the outcome on the welcome notice; the
  Membership screen has a "partner membership" card to paste a token or retry the stored one.
- Backoffice: `/admin/referrals` (counts, filters, "Run vesting now"), `/admin/partners` (+ detail:
  edit for ADMIN, read-only for OPS, claims list), member page gained a Referrals table and partner
  claims in the Account card. Nav gained Referrals and Partners.
- `docs/PARTNER_TOKEN.md`: the JWT contract for EventOS (claims, uniqueness rules, issuing example,
  promo kinds, key rotation).
- Tests: `tests/referrals.test.ts` (6) + `tests/partners.test.ts` (6) → 101 total. Invariant 8:
  every pending reason in order, pay-once, tourist never vests, the three rejections with flags, the
  monthly cap rolling into next month. Invariant 9: a token, its `jti` and its external member id
  each refuse a second claim; expired / wrong key / `HS256` / `none` / malformed / unknown or paused
  community refused without side effects; the plan promo refuses a Stripe-paying member and leaves
  no claim; the 3-month plan promo grants month 2 and 3 and expires back to FREE.

**Decisions**

- A referral is only recorded when the referrer's code is active at signup, and only vests while
  the referrer is still paid. A lapsed referrer's pending referrals wait rather than being rejected.
- Over-cap referrals wait for the next calendar month (UTC) instead of being lost.
- Fingerprint rejections open a fraud flag under the existing `SELF_REFERRAL` rule (evidence says
  which kind) rather than adding enum values.
- Partner promo periods count as "paid" for everything except referral vesting (`firstPaidAt`
  stays null) — so an ELL member's own referral code is active during the promo.
- `runMonthlyGrants` now rolls the period only for the FREE tier; any other local subscription
  (tourist, promo) has a fixed end and expires back to FREE.
- Token verification is hand-rolled on `node:crypto` to avoid a JWT dependency; the payload is
  three required fields.

**Open**

- A paying member who receives a `PLAN_PERIOD` promo is refused; partners wanting to reward
  existing subscribers should use `STRIPE_COUPON` or `KEYS`.
- EventOS's issuing side is not built yet (the contract is in `docs/PARTNER_TOKEN.md`).
- The "Invite" tab makes the member nav scroll on narrow phones.
