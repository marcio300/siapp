import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { getBalance } from "@/domain/keys";
import { ensureFreeSubscription, getMembership, runExpirePeriods, runMonthlyGrants, setBillingStripeForTests, type BillingStripe } from "@/domain/billing";
import { isReferralCodeActive } from "@/domain/referrals";
import { PartnerCommunityError, PartnerError, claimPartnerToken, claimStoredToken, createPartnerCommunity, updatePartnerCommunity, verifyClaimToken } from "@/domain/partners";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const DAY = 86_400_000;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function b64(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function sign(payload: Record<string, unknown>, opts: { key?: typeof keys.privateKey; alg?: string } = {}) {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT" };
  const body = `${b64(header)}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(body).end().sign(opts.key ?? keys.privateKey).toString("base64url");
  return `${body}.${sig}`;
}
const expIn = (days: number) => Math.floor((Date.now() + days * DAY) / 1000);
let n = 0;
const ellToken = (extra: Record<string, unknown> = {}) => sign({ source: "ELL", externalMemberId: `ell-${++n}`, name: "Erasmus Student", exp: expIn(7), jti: `jti-${n}`, ...extra });

describe("partner communities (ELL bridge)", () => {
  const stripeCalls: unknown[] = [];
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    await createPartnerCommunity({ code: "ell", name: "Erasmus Life Lisboa", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "PLAN_PERIOD", tier: "SOCIAL", months: 3 }) });
    const stripe: BillingStripe = {
      customers: { async create() { return { id: "cus" }; } },
      checkout: { sessions: { async create() { return { id: "cs", url: "" }; } } },
      subscriptions: {
      async cancel() {
        return {};
      }, async retrieve(id) { return { id, items: { data: [] } }; }, async update(id, params) { stripeCalls.push({ id, params }); return {}; } },
      billingPortal: { sessions: { async create() { return { url: "" }; } } },
      refunds: { async create() { return { id: "re" }; } },
    };
    setBillingStripeForTests(stripe);
  });

  it("community CRUD validates the PEM and the promo JSON", async () => {
    await expect(createPartnerCommunity({ code: "x", name: "Bad", publicKey: PUBLIC_PEM, promo: "{}" })).rejects.toThrow(/Code needs/);
    await expect(createPartnerCommunity({ code: "BAD", name: "Bad", publicKey: "not a pem", promo: "{}" })).rejects.toThrow(/RSA public key/);
    await expect(createPartnerCommunity({ code: "BAD", name: "Bad", publicKey: PUBLIC_PEM, promo: "nope" })).rejects.toThrow(/valid JSON/);
    await expect(createPartnerCommunity({ code: "BAD", name: "Bad", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "PLAN_PERIOD", tier: "FREE", months: 3 }) })).rejects.toThrow(PartnerCommunityError);
    await expect(createPartnerCommunity({ code: "ELL", name: "Dup", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "KEYS", keys: 5 }) })).rejects.toThrow(/already taken/);
    const c = await createPartnerCommunity({ code: "campus", name: "Campus Club", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "KEYS", keys: 50 }) });
    expect(c.code).toBe("CAMPUS");
    await updatePartnerCommunity(c.id, { code: "CAMPUS", name: "Campus Club", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "KEYS", keys: 50 }), isActive: true });
  });

  it("verifies RS256 tokens: wrong key, other alg, expiry, missing claims, malformed", () => {
    const good = verifyClaimToken(ellToken({ externalMemberId: "ell-ok" }), PUBLIC_PEM);
    expect(good).toMatchObject({ source: "ELL", externalMemberId: "ell-ok", name: "Erasmus Student" });
    const tryIt = (t: string) => {
      try {
        verifyClaimToken(t, PUBLIC_PEM);
        return "ok";
      } catch (e) {
        return (e as PartnerError).reason;
      }
    };
    expect(tryIt(ellToken({}).slice(0, -3) + "abc")).toBe("bad_signature");
    expect(tryIt(sign({ source: "ELL", externalMemberId: "x", exp: expIn(1) }, { key: otherKeys.privateKey }))).toBe("bad_signature");
    expect(tryIt(sign({ source: "ELL", externalMemberId: "x", exp: expIn(1) }, { alg: "HS256" }))).toBe("unsupported_alg");
    expect(tryIt(sign({ source: "ELL", externalMemberId: "x", exp: expIn(1) }, { alg: "none" }))).toBe("unsupported_alg");
    expect(tryIt(sign({ source: "ELL", externalMemberId: "x", exp: expIn(-1) }))).toBe("expired");
    expect(tryIt(sign({ source: "ELL", externalMemberId: "x" }))).toBe("missing_claims");
    expect(tryIt(sign({ source: "ELL", exp: expIn(1) }))).toBe("missing_claims");
    expect(tryIt("hello")).toBe("malformed");
    expect(tryIt("a.b.c")).toBe("malformed");
  });

  it("PLAN_PERIOD claim: paid tier for N months with no Stripe, keys monthly, back to FREE at the end, token forgotten", async () => {
    const m = await createMember();
    const free = (await ensureFreeSubscription(m.id))!;
    const token = ellToken({ externalMemberId: "ell-plan" });
    await prisma.member.update({ where: { id: m.id }, data: { partnerClaimToken: token, partnerClaimTokenAt: new Date() } });
    const now = new Date();
    const res = await claimStoredToken(m.id, { now });
    expect(res).toMatchObject({ community: { code: "ELL" }, externalMemberId: "ell-plan", applied: expect.stringMatching(/SOCIAL for 3 months/) });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { memberId: m.id, status: "ACTIVE" }, include: { plan: { include: { tier: true } } } });
    expect(sub.plan.tier.code).toBe("SOCIAL");
    expect(sub.stripeSubscriptionId).toBeNull();
    expect(sub.firstPaidAt).toBeNull();
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(now.getTime() + 89 * DAY);
    expect(sub.nextGrantAt).not.toBeNull();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: free.id } })).status).toBe("EXPIRED");
    expect(await getBalance(m.id, { now })).toMatchObject({ planKeys: 30 });
    expect(await getMembership(m.id)).toMatchObject({ tierCode: "SOCIAL", isPaid: true, isTourist: false, isRecurring: false });
    expect(await isReferralCodeActive(m.id)).toBe(true);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).partnerClaimToken).toBeNull();
    expect(await prisma.partnerClaim.findFirst({ where: { memberId: m.id } })).toMatchObject({ externalMemberId: "ell-plan", tokenJti: expect.stringMatching(/^jti-/) });

    // month 2 and 3 grants, then expiry back to FREE
    const month2 = new Date(now.getTime() + 32 * DAY);
    expect((await runMonthlyGrants({ now: month2, memberId: m.id })).granted).toBe(1);
    expect(await getBalance(m.id, { now: month2 })).toMatchObject({ planKeys: 30 });
    const month3 = new Date(now.getTime() + 63 * DAY);
    expect((await runMonthlyGrants({ now: month3, memberId: m.id })).granted).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextGrantAt).toBeNull();
    const after = new Date(now.getTime() + 95 * DAY);
    expect((await runExpirePeriods({ now: after, memberId: m.id })).expiredPasses).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("EXPIRED");
    expect(await getMembership(m.id)).toMatchObject({ tierCode: "FREE" });
    expect(await getBalance(m.id, { now: after })).toMatchObject({ planKeys: 2 }); // back on FREE: its 2 keys
    expect(await claimStoredToken(m.id)).toBeNull();
  });

  it("invariant 9: a token (or its external member) can't be claimed twice; one claim per member per community", async () => {
    const token = ellToken({ externalMemberId: "ell-once", jti: "jti-once" });
    const a = await createMember();
    await claimPartnerToken(a.id, token);
    await expect(claimPartnerToken(a.id, token)).rejects.toMatchObject({ reason: "already_claimed" });
    await expect(claimPartnerToken(a.id, ellToken({}))).rejects.toMatchObject({ reason: "already_claimed" });
    const b = await createMember();
    await expect(claimPartnerToken(b.id, token)).rejects.toMatchObject({ reason: "already_used" });
    await expect(claimPartnerToken(b.id, ellToken({ externalMemberId: "ell-once" }))).rejects.toMatchObject({ reason: "already_used" });
    await expect(claimPartnerToken(b.id, ellToken({ jti: "jti-once" }))).rejects.toMatchObject({ reason: "already_used" });
    expect(await prisma.partnerClaim.count({ where: { memberId: b.id } })).toBe(0);
    expect(await prisma.subscription.count({ where: { memberId: b.id, plan: { tier: { code: "SOCIAL" } } } })).toBe(0);
  });

  it("refuses bad tokens without side effects: expired, wrong key, unknown or paused community, paying member", async () => {
    const m = await createMember();
    await expect(claimPartnerToken(m.id, ellToken({ exp: expIn(-1) }))).rejects.toMatchObject({ reason: "expired" });
    await expect(claimPartnerToken(m.id, sign({ source: "ELL", externalMemberId: "z", exp: expIn(1) }, { key: otherKeys.privateKey }))).rejects.toMatchObject({ reason: "bad_signature" });
    await expect(claimPartnerToken(m.id, sign({ source: "NOPE", externalMemberId: "z", exp: expIn(1) }))).rejects.toMatchObject({ reason: "unknown_community" });
    await expect(claimPartnerToken(m.id, "garbage")).rejects.toMatchObject({ reason: "malformed" });
    const c = await prisma.partnerCommunity.findUniqueOrThrow({ where: { code: "ELL" } });
    await prisma.partnerCommunity.update({ where: { id: c.id }, data: { isActive: false } });
    await expect(claimPartnerToken(m.id, ellToken({}))).rejects.toMatchObject({ reason: "community_inactive" });
    await prisma.partnerCommunity.update({ where: { id: c.id }, data: { isActive: true } });
    expect(await prisma.partnerClaim.count({ where: { memberId: m.id } })).toBe(0);

    // already paying via Stripe → PLAN_PERIOD can't stack; no claim row stays behind
    const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "REGULAR" } } });
    await prisma.subscription.create({ data: { memberId: m.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), stripeSubscriptionId: `sub_${m.id}`, firstPaidAt: new Date() } });
    await expect(claimPartnerToken(m.id, ellToken({}))).rejects.toMatchObject({ reason: "promo_failed", message: expect.stringMatching(/already have a paid plan/) });
    expect(await prisma.partnerClaim.count({ where: { memberId: m.id } })).toBe(0);
  });

  it("KEYS and STRIPE_COUPON promos", async () => {
    const m = await createMember();
    const campus = sign({ source: "CAMPUS", externalMemberId: "c-1", exp: expIn(1) });
    const res = await claimPartnerToken(m.id, campus);
    expect(res.applied).toMatch(/50 keys/);
    expect(await getBalance(m.id)).toMatchObject({ purchasedKeys: 50 });
    const row = await prisma.keyTransaction.findFirstOrThrow({ where: { memberId: m.id, type: "PROMO_GRANT" } });
    expect(row.reference).toBe(`partner:${res.claimId}`);

    await createPartnerCommunity({ code: "ALUMNI", name: "Alumni", publicKey: PUBLIC_PEM, promo: JSON.stringify({ kind: "STRIPE_COUPON", couponId: "ALUMNI20" }) });
    const freeMember = await createMember();
    await expect(claimPartnerToken(freeMember.id, sign({ source: "ALUMNI", externalMemberId: "a-1", exp: expIn(1) }))).rejects.toMatchObject({ reason: "promo_failed", message: expect.stringMatching(/subscribe first/) });
    expect(await prisma.partnerClaim.count({ where: { memberId: freeMember.id } })).toBe(0);
    const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } } });
    await prisma.subscription.create({ data: { memberId: freeMember.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), stripeSubscriptionId: "sub_alumni", firstPaidAt: new Date() } });
    const r2 = await claimPartnerToken(freeMember.id, sign({ source: "ALUMNI", externalMemberId: "a-1", exp: expIn(1) }));
    expect(r2.applied).toMatch(/ALUMNI20/);
    expect(stripeCalls).toEqual([{ id: "sub_alumni", params: { discounts: [{ coupon: "ALUMNI20" }] } }]);
  });
});
