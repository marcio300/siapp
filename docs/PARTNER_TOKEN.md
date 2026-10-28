# Partner claim token — contract for EventOS (and any partner community)

SIAPP lets members of a partner community (first: **ELL**, Erasmus Life Lisboa) claim a promo
membership without any shared database. The partner issues a **signed, single-use claim token**; the
member pastes it into SIAPP at onboarding or on the Membership screen; SIAPP verifies the signature
with the partner's public key, records the claim once, and applies the promo configured in the
backoffice (Partners → community → Promo).

## Token format

A compact **JWS / JWT**, three base64url segments, signed **RS256** (RSASSA-PKCS1-v1_5 with SHA-256)
with the partner's RSA private key (2048 bits or more). No other algorithm is accepted — `HS256`,
`none` and the ES family are rejected before any other check.

Header:

```json
{ "alg": "RS256", "typ": "JWT" }
```

Payload:

| Claim | Required | Meaning |
|---|---|---|
| `source` | yes | The community code configured in SIAPP, e.g. `"ELL"`. Case-insensitive. |
| `externalMemberId` | yes | The partner's own stable id for this person (their member/customer id). **One claim per id, ever.** |
| `exp` | yes | Expiry, seconds since epoch. Recommended: issue time + 7 days. 60 s of clock skew tolerated. |
| `jti` | recommended | Unique token id. Also enforced unique in SIAPP, so a re-issued token for the same person still can't double-claim. |
| `iat` | optional | Issue time, seconds since epoch. |
| `name` | optional | Display name. Not stored. |
| `email` | optional | Not used for matching (SIAPP accounts are keyed by the email the member signs in with). |

Example payload:

```json
{
  "source": "ELL",
  "externalMemberId": "cust_01HZX…",
  "name": "Ana Silva",
  "iat": 1761600000,
  "exp": 1762204800,
  "jti": "0f6c4c8a-7d1e-4d3b-9b2e-2f0a9a1c5e11"
}
```

## Uniqueness rules (what "single-use" means)

SIAPP stores `PartnerClaim(communityId, externalMemberId)` with a unique constraint and
`tokenJti` unique. A second claim is refused when **any** of these already exist:

- the same `externalMemberId` for the same community (another SIAPP account, or the same one);
- the same `jti`;
- the same SIAPP member already holds a claim for that community.

Refusals carry a reason the member sees: `already_used`, `already_claimed`, `expired`,
`bad_signature`, `unsupported_alg`, `unknown_community`, `community_inactive`, `missing_claims`,
`malformed`, `promo_failed` (e.g. a plan promo on a member who already pays through Stripe).

## Issuing side (EventOS)

1. Generate an RSA key pair once per community. Keep the private key in EventOS's secrets; paste the
   **public key PEM** (`-----BEGIN PUBLIC KEY-----`, SPKI) into SIAPP → Partners.
2. When a verified community member asks for their SIAPP promo (button in their EventOS account),
   sign a payload as above and show the token (or a link `https://<siapp>/app/membership` with the
   token prefilled in the clipboard). Keep `exp` short; a fresh token can always be issued — the
   `externalMemberId` rule is what prevents double claims, not the expiry.
3. Nothing needs to be called back: SIAPP does not notify EventOS of claims. If you want a report,
   the backoffice lists claims per community.

Node.js example:

```ts
import { createSign, randomUUID } from "node:crypto";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
  source: "ELL",
  externalMemberId: customer.id,
  name: customer.name,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  jti: randomUUID(),
})}`;
const token = `${body}.${createSign("RSA-SHA256").update(body).end().sign(PRIVATE_KEY_PEM).toString("base64url")}`;
```

Any JWT library producing RS256 (`jose`, `jsonwebtoken`) is equivalent.

## Promo kinds (configured in SIAPP, not in the token)

| `promo` JSON | Effect |
|---|---|
| `{"kind":"PLAN_PERIOD","tier":"SOCIAL","months":3}` | A paid tier for N months with no Stripe subscription. Keys land monthly; the member drops back to FREE at the end. Refused for members already paying through Stripe. Never counts for referral vesting. |
| `{"kind":"KEYS","keys":20}` | Purchased-pool keys that never expire. Works for anyone. |
| `{"kind":"STRIPE_COUPON","couponId":"ELL20"}` | Applies a Stripe coupon to the member's live subscription. Requires one. |

Rotating keys: paste the new public key over the old one; tokens signed with the old key stop
verifying immediately, so publish the new key before switching the signer.
