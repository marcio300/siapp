# Decisions pending (owner)

Things built with a stated assumption that the owner has not confirmed yet. Each one works as-is;
the question is whether the assumption is the one you want. Discuss, decide, then move the item to
`docs/BUILD_LOG.md` under the phase's "Decisions".

| # | Phase | Question | Built as (today) | Alternatives |
|---|---|---|---|---|
| 1 | 8 | **+1 on a discounted ticket: does the producer get the +1 money?** We charge the member `plusOneExtraCashCents` for the guest. | Only the ticket's own `face × (1 − discount%)` is settled; the +1 cash stays with us. | Settle a second line at the same discounted face for the +1; or settle exactly what we charged for the +1. |
| 2 | 8 | **Late scans after a settlement exists.** The statement is computed once, from what the door had scanned when the hourly job ran. | Not added later; reopen + manual adjustment doesn't exist. | Recompute while OPEN; or append lines with a "late" marker. |
| 3 | 7 | **Referral recorded only when the referrer's code is active at signup.** | Inactive code (FREE / tourist referrer) → the signup proceeds with no referral and a notice. | Record anyway and let it vest later if the referrer upgrades. |
| 4 | 7 | **Over-cap referrals** (more than `referral_monthly_cap` vesting in a month). | They wait and vest next month. | Reject them; or pay keys to the invitee only. |
| 5 | 7 | **Partner `PLAN_PERIOD` promo for a member already paying through Stripe.** | Refused ("already on a paid plan"); partners should use `KEYS` or `STRIPE_COUPON` for existing subscribers. | Extend the current period; or queue the promo for after the paid plan ends. |
| 6 | 7 | **Partner promo counts as "paid" for the member's own referral code** but never for referral vesting of the member as an invitee. | As stated. | Promo members' codes inactive until they pay. |
| 7 | 6 | **PAY_DOOR after the window: who confirms the guest paid?** | The door taps "Paid at the door — admit"; the second tap checks the member in. No amount is recorded. | Record the door amount; or auto-admit with a note. |
| 8 | 6 | **Door identity.** Scanner sessions are per event with a free-text device label; no per-person login. | As stated (matches "producers have no portal"). | Staff `DOOR` accounts for our own people. |
| 9 | 5 | **Discounted tickets pay through Stripe Checkout** (redirect), not an in-app Payment Element. | Checkout. | Payment Element later if the redirect hurts conversion. |
| 10 | 5 | **A HELD redemption with cash due, once approved, gets 24 h to pay** (not the 10-minute window). | 24 h. | Shorter window; or auto-charge a saved card. |
| 11 | 5 | **Keys are debited at creation for every outcome** (pending / held / active); refunds on expiry or denial. | As stated. | Debit only when ACTIVE. |
| 12 | 3 | **Velocity thresholds** (`velocity_first_hour_max` 3, `velocity_private_sale_first_day_max` 1, `device_max_accounts` 3, `same_card_max_accounts` 1) are placeholders. | Settings table; editable in the backoffice. | Tune once there is traffic. |
| 13 | 2 | **Price changes and existing subscribers.** Stripe prices are immutable; a new price rotates in for new checkouts. | Existing subscribers keep their old price until moved by hand in Stripe. | A "migrate subscribers" action. |
| 14 | 0 | **Key pack 50 keys priced at €20** (spec said €18, which broke the spec's own "never cheaper per key than REGULAR" rule). | €20 (test enforces the rule). | Change the rule or the price. |
| 15 | 10 | **Apple / Google Wallet passes** — EventOS has nothing to port. | Not built. | Build with PassKit / Google Wallet API in Phase 10. |
| 16 | 8 | **Producers without a contact email** settle silently (no statement sent). | Ledger shows "no contact email". | Block publishing events for producers without an email. |

Also waiting on you (not design questions): live Stripe keys + `stripe listen` test, Vercel + Neon
deployment, Resend domain, `DATA_ENCRYPTION_KEY` for production, the EventOS issuing side of partner
tokens (`docs/PARTNER_TOKEN.md`).
