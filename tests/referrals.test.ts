import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { getBalance } from "@/domain/keys";
import { completeOnboarding } from "@/domain/identity";
import { inviteeLabel, referralOverview, vestReferral, vestReferrals } from "@/domain/referrals";
import { prisma, resetDatabase } from "./db";
import { createMember, createRedemption } from "./fixtures";

const DAY = 86_400_000;
let cityId: string;

async function planFor(tier: "FREE" | "SOCIAL" | "REGULAR", period: "MONTHLY" | "TOURIST_WEEK" = "MONTHLY") {
  return prisma.plan.findFirstOrThrow({ where: { period, tier: { code: tier } } });
}

/** Member on `tier`; paid plans get a Stripe id and firstPaidAt = now − paidDaysAgo. */
async function memberOn(tier: "FREE" | "SOCIAL" | "REGULAR", paidDaysAgo = 0, period: "MONTHLY" | "TOURIST_WEEK" = "MONTHLY") {
  const m = await createMember();
  const plan = await planFor(tier, period);
  const paid = tier !== "FREE" && period === "MONTHLY";
  await prisma.subscription.create({
    data: { memberId: m.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), stripeSubscriptionId: paid ? `sub_${m.id}` : null, firstPaidAt: paid ? new Date(Date.now() - paidDaysAgo * DAY) : null },
  });
  return m;
}

async function refer(referrerId: string, inviteeId: string) {
  const referrer = await prisma.member.findUniqueOrThrow({ where: { id: referrerId } });
  return prisma.referral.create({ data: { referrerId, inviteeId, code: referrer.referralCode } });
}

async function checkIn(memberId: string) {
  const r = await createRedemption(memberId);
  await prisma.redemption.update({ where: { id: r.id }, data: { status: "CHECKED_IN", checkedInAt: new Date() } });
}

describe("referrals", () => {
  beforeAll(async () => {
    await resetDatabase();
    cityId = (await runSeed(prisma, { adminEmail: "admin@test.siapp" })).cityId;
  });

  it("onboarding records a referral only for an active (paid, non-tourist) code", async () => {
    const paid = await memberOn("SOCIAL", 1);
    const free = await memberOn("FREE");
    const tourist = await memberOn("REGULAR", 0, "TOURIST_WEEK");
    const base = { name: "Nova Member", dateOfBirth: "1990-05-05", cityId };
    const a = await createMember();
    expect((await completeOnboarding(a.id, { ...base, referralCode: paid.referralCode })).referral).toBe("recorded");
    expect(await prisma.referral.findUnique({ where: { inviteeId: a.id } })).toMatchObject({ referrerId: paid.id, status: "PENDING", code: paid.referralCode });
    const b = await createMember();
    expect((await completeOnboarding(b.id, { ...base, referralCode: free.referralCode })).referral).toBe("inactive_code");
    expect(await prisma.referral.findUnique({ where: { inviteeId: b.id } })).toBeNull();
    const c = await createMember();
    expect((await completeOnboarding(c.id, { ...base, referralCode: tourist.referralCode })).referral).toBe("inactive_code");
    const d = await createMember();
    expect((await completeOnboarding(d.id, { ...base, referralCode: d.referralCode })).referral).toBe("self");
    expect((await completeOnboarding(d.id, { ...base, referralCode: "NOPE123" })).referral).toBe("unknown_code");
  });

  it("invariant 8: vests only after the refund window AND a scanned ticket, with the referrer still paid; pays once", async () => {
    const referrer = await memberOn("FREE");
    const invitee = await memberOn("FREE");
    const ref = await refer(referrer.id, invitee.id);
    expect(await vestReferral(ref.id)).toMatchObject({ outcome: "pending", reason: "invitee_not_paid" });

    // invitee pays today → refund window
    await prisma.subscription.updateMany({ where: { memberId: invitee.id }, data: { planId: (await planFor("SOCIAL")).id, stripeSubscriptionId: `sub_${invitee.id}`, firstPaidAt: new Date() } });
    expect(await vestReferral(ref.id)).toMatchObject({ outcome: "pending", reason: "refund_window" });
    expect(await vestReferral(ref.id, { now: new Date(Date.now() + 29 * DAY) })).toMatchObject({ outcome: "pending", reason: "refund_window" });

    // past the window but never showed up
    const later = new Date(Date.now() + 31 * DAY);
    expect(await vestReferral(ref.id, { now: later })).toMatchObject({ outcome: "pending", reason: "invitee_no_show_yet" });
    await checkIn(invitee.id);

    // referrer dropped to FREE meanwhile → waits
    expect(await vestReferral(ref.id, { now: later })).toMatchObject({ outcome: "pending", reason: "referrer_not_paid" });
    await prisma.subscription.updateMany({ where: { memberId: referrer.id }, data: { planId: (await planFor("REGULAR")).id, stripeSubscriptionId: `sub_${referrer.id}`, firstPaidAt: new Date() } });

    expect(await vestReferral(ref.id, { now: later })).toMatchObject({ outcome: "vested", reason: "vested" });
    const vested = await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } });
    expect(vested.status).toBe("VESTED");
    expect(vested.vestedAt?.getTime()).toBe(later.getTime());
    expect(await getBalance(referrer.id, { now: later })).toMatchObject({ purchasedKeys: 10 });
    expect(await getBalance(invitee.id, { now: later })).toMatchObject({ purchasedKeys: 10 });
    const rows = await prisma.keyTransaction.findMany({ where: { type: "REFERRAL_BONUS", memberId: { in: [referrer.id, invitee.id] } } });
    expect(rows.map((r) => r.reference).sort()).toEqual([`referral:${ref.id}:invitee`, `referral:${ref.id}:referrer`]);

    // never twice
    expect(await vestReferral(ref.id, { now: later })).toMatchObject({ outcome: "vested", reason: "already_vested" });
    expect(await vestReferrals({ now: later, referrerId: referrer.id })).toEqual({ vested: 0, rejected: 0, pending: 0 });
    expect(await prisma.keyTransaction.count({ where: { type: "REFERRAL_BONUS", memberId: { in: [referrer.id, invitee.id] } } })).toBe(2);
  });

  it("a tourist pass never starts the vesting clock", async () => {
    const referrer = await memberOn("SOCIAL", 1);
    const invitee = await memberOn("REGULAR", 0, "TOURIST_WEEK");
    await checkIn(invitee.id);
    const ref = await refer(referrer.id, invitee.id);
    expect(await vestReferral(ref.id, { now: new Date(Date.now() + 60 * DAY) })).toMatchObject({ outcome: "pending", reason: "invitee_not_paid" });
  });

  it("rejects (and flags) shared device or card fingerprints, and self-referral", async () => {
    const referrer = await memberOn("SOCIAL", 40);
    const invitee = await memberOn("SOCIAL", 40);
    await prisma.device.createMany({ data: [{ memberId: referrer.id, fingerprint: "fp-shared" }, { memberId: invitee.id, fingerprint: "fp-shared" }] });
    const ref = await refer(referrer.id, invitee.id);
    expect(await vestReferral(ref.id)).toMatchObject({ outcome: "rejected", reason: "shared_device" });
    expect(await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({ status: "REJECTED", rejectedReason: "shared_device" });
    const flag = await prisma.fraudFlag.findFirstOrThrow({ where: { memberId: invitee.id, rule: "SELF_REFERRAL" } });
    expect(flag).toMatchObject({ status: "OPEN", evidence: expect.objectContaining({ referralId: ref.id, reason: "shared_device", fingerprint: "fp-shared" }) });
    expect(await vestReferral(ref.id)).toMatchObject({ outcome: "rejected" });

    const referrer2 = await memberOn("SOCIAL", 40);
    const invitee2 = await memberOn("SOCIAL", 40);
    await prisma.paymentMethodFingerprint.createMany({ data: [{ memberId: referrer2.id, fingerprint: "card-1" }, { memberId: invitee2.id, fingerprint: "card-1" }] });
    const ref2 = await refer(referrer2.id, invitee2.id);
    expect(await vestReferral(ref2.id)).toMatchObject({ outcome: "rejected", reason: "shared_card" });

    const self = await memberOn("SOCIAL", 40);
    const ref3 = await prisma.referral.create({ data: { referrerId: self.id, inviteeId: self.id, code: self.referralCode } });
    expect(await vestReferral(ref3.id)).toMatchObject({ outcome: "rejected", reason: "self_referral" });
    expect(await getBalance(invitee.id)).toMatchObject({ purchasedKeys: 0 });
  });

  it("monthly cap: extra referrals wait for next month; the job reports counts", async () => {
    await prisma.setting.update({ where: { key: "referral_monthly_cap" }, data: { value: 2 } });
    const referrer = await memberOn("REGULAR", 40);
    const refs = [];
    for (let i = 0; i < 3; i++) {
      const invitee = await memberOn("SOCIAL", 40);
      await checkIn(invitee.id);
      refs.push(await refer(referrer.id, invitee.id));
    }
    const now = new Date();
    expect(await vestReferrals({ now, referrerId: referrer.id })).toEqual({ vested: 2, rejected: 0, pending: 1 });
    expect(await vestReferral(refs[2]!.id, { now })).toMatchObject({ outcome: "pending", reason: "monthly_cap" });
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    expect(await vestReferral(refs[2]!.id, { now: nextMonth })).toMatchObject({ outcome: "vested" });
    expect(await getBalance(referrer.id, { now: nextMonth })).toMatchObject({ purchasedKeys: 30 });
    await prisma.setting.update({ where: { key: "referral_monthly_cap" }, data: { value: 20 } });

    const overview = await referralOverview(referrer.id, { now: nextMonth });
    expect(overview).toMatchObject({ code: referrer.referralCode, active: true, bonusKeys: 10, monthlyCap: 20, vestedThisMonth: 1, keysEarned: 30, counts: { pending: 0, vested: 3, rejected: 0 }, referredBy: null });
    expect(overview.link).toMatch(new RegExp(`/r/${referrer.referralCode}$`));
    expect(overview.referrals).toHaveLength(3);
    expect((await referralOverview((await memberOn("FREE")).id)).active).toBe(false);
  });

  it("invitee labels never leak the email", () => {
    expect(inviteeLabel({ name: "Ana Maria Silva", email: "x@y.z" })).toBe("Ana S.");
    expect(inviteeLabel({ name: "Bo", email: "x@y.z" })).toBe("Bo");
    expect(inviteeLabel({ name: null, email: "carla@example.com" })).toBe("ca•••");
  });
});
