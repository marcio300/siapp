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
