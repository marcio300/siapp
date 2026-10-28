import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { handleStripeEvent } from "@/lib/stripe-webhook";
import { banMember, deviceOverlap, evaluate, recordDevice, registerFraudWebhooks, reviewFlag, ReviewError, unbanMember } from "@/domain/fraud";
import { prisma, resetDatabase } from "./db";
import { createCity, createMember, createRedemption, createStaff } from "./fixtures";

const HOUR = 3_600_000;

/** Offer on a fresh event starting `startOffsetHours` from now; optionally a private sale. */
async function makeOffer(startOffsetHours: number, privateSale = false) {
  const city = await createCity();
  const producer = await prisma.producer.create({ data: { cityId: city.id, name: `P ${Math.random()}` } });
  const startsAt = new Date(Date.now() + startOffsetHours * HOUR);
  const event = await prisma.event.create({
    data: { producerId: producer.id, cityId: city.id, title: `E ${startOffsetHours}`, startsAt, endsAt: new Date(startsAt.getTime() + 5 * HOUR), status: "PUBLISHED", scannerCode: `${Date.now()}${Math.random()}`, scannerPinHash: "x" },
  });
  return prisma.offer.create({
    data: { eventId: event.id, name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 100, privateSaleTiers: privateSale ? ["PLUS"] : [] },
  });
}

async function redeem(memberId: string, offerId: string, status: "ACTIVE" | "HELD" | "CANCELLED" = "ACTIVE") {
  const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId }, include: { event: true } });
  return prisma.redemption.create({
    data: { memberId, offerId, eventId: offer.eventId, status, keyCost: 10, cancelDeadlineAt: new Date(offer.event.startsAt.getTime() - 24 * HOUR) },
  });
}

/** Backdate the member so velocity rules don't see a brand-new account. */
async function age(memberId: string, hours: number) {
  await prisma.member.update({ where: { id: memberId }, data: { createdAt: new Date(Date.now() - hours * HOUR) } });
}

describe("fraud", () => {
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    registerFraudWebhooks();
  });

  it("ALLOW for a clean, established member", async () => {
    const m = await createMember();
    await age(m.id, 48);
    const offer = await makeOffer(72);
    expect(await evaluate(m.id, offer.id)).toEqual({ decision: "ALLOW", fired: [] });
    expect(await prisma.fraudFlag.count({ where: { memberId: m.id } })).toBe(0);
  });

  it("DEVICE_MAX_ACCOUNTS: the 4th account on one fingerprint is flagged at login and at evaluation", async () => {
    const members = await Promise.all([createMember(), createMember(), createMember(), createMember()]);
    for (const [i, m] of members.entries()) {
      const r = await recordDevice(m.id, "fp-shared-1", "UA");
      expect(r.flagged).toBe(i === 3);
    }
    expect(await prisma.fraudFlag.count({ where: { rule: "DEVICE_MAX_ACCOUNTS", status: "OPEN" } })).toBe(1);
    // Repeated logins don't pile up flags.
    await recordDevice(members[3]!.id, "fp-shared-1", "UA");
    expect(await prisma.fraudFlag.count({ where: { rule: "DEVICE_MAX_ACCOUNTS", status: "OPEN" } })).toBe(1);
    await age(members[0]!.id, 48);
    const offer = await makeOffer(72);
    const result = await evaluate(members[0]!.id, offer.id);
    expect(result.decision).toBe("REVIEW");
    expect(result.fired.map((f) => f.rule)).toEqual(["DEVICE_MAX_ACCOUNTS"]);
    expect(result.fired[0]!.evidence).toMatchObject({ accountsOnDevice: 4, max: 3 });
    const overlap = await deviceOverlap(members[0]!.id);
    expect(overlap[0]!.sharedWith).toHaveLength(3);
  });

  it("VELOCITY_FIRST_HOUR: a new account's 4th redemption in its first hour is reviewed", async () => {
    const m = await createMember();
    for (let i = 0; i < 2; i++) await redeem(m.id, (await makeOffer(100 + i * 10)).id);
    expect((await evaluate(m.id, (await makeOffer(200)).id)).decision).toBe("ALLOW");
    await redeem(m.id, (await makeOffer(130)).id);
    await redeem(m.id, (await makeOffer(140)).id, "CANCELLED"); // dead redemptions don't count
    const result = await evaluate(m.id, (await makeOffer(300)).id);
    expect(result.fired.map((f) => f.rule)).toEqual(["VELOCITY_FIRST_HOUR"]);
    expect(result.fired[0]!.evidence).toMatchObject({ redemptionsInFirstHour: 3, max: 3 });
    // The same member two hours later: the rule no longer applies.
    await age(m.id, 2);
    expect((await evaluate(m.id, (await makeOffer(400)).id)).decision).toBe("ALLOW");
  });

  it("VELOCITY_PRIVATE_SALE: a second private-sale redemption on day one is reviewed", async () => {
    const m = await createMember();
    await age(m.id, 5);
    await redeem(m.id, (await makeOffer(100, true)).id);
    expect((await evaluate(m.id, (await makeOffer(200, false)).id)).decision).toBe("ALLOW");
    const result = await evaluate(m.id, (await makeOffer(300, true)).id);
    expect(result.fired.map((f) => f.rule)).toEqual(["VELOCITY_PRIVATE_SALE"]);
    await age(m.id, 30);
    expect((await evaluate(m.id, (await makeOffer(400, true)).id)).decision).toBe("ALLOW");
  });

  it("OVERLAP: a live redemption for another event within the tolerance window is reviewed", async () => {
    const m = await createMember();
    await age(m.id, 48);
    const first = await makeOffer(72);
    await redeem(m.id, first.id);
    const within = await makeOffer(74); // 2 h later, tolerance 3 h
    const result = await evaluate(m.id, within.id);
    expect(result.fired.map((f) => f.rule)).toEqual(["OVERLAP"]);
    expect(result.fired[0]!.evidence).toMatchObject({ toleranceHours: 3 });
    expect((await evaluate(m.id, (await makeOffer(76)).id)).decision).toBe("ALLOW"); // 4 h later
    // Another offer on the SAME event never overlaps with itself.
    const sameEvent = await prisma.offer.create({ data: { eventId: first.eventId, name: "VIP", type: "FREE_TICKET", keyCost: 20, allocationType: "CAPPED", capacity: 10 } });
    expect((await evaluate(m.id, sameEvent.id)).decision).toBe("ALLOW");
    // A cancelled redemption does not block.
    const m2 = await createMember();
    await age(m2.id, 48);
    await redeem(m2.id, first.id, "CANCELLED");
    expect((await evaluate(m2.id, within.id)).decision).toBe("ALLOW");
  });

  it("SAME_CARD: charge.succeeded records the card fingerprint; a card on two accounts is reviewed", async () => {
    const a = await createMember();
    const b = await createMember();
    await age(a.id, 48);
    await age(b.id, 48);
    await prisma.stripeCustomer.create({ data: { memberId: a.id, stripeCustomerId: "cus_a" } });
    await prisma.stripeCustomer.create({ data: { memberId: b.id, stripeCustomerId: "cus_b" } });
    const charge = (id: string, customer: string) => ({
      id: `evt_${id}`,
      type: "charge.succeeded",
      data: { object: { id, customer, payment_method_details: { card: { fingerprint: "fp_card_1", brand: "visa", last4: "4242" } } } },
    });
    expect((await handleStripeEvent(charge("ch_1", "cus_a"))).status).toBe("processed");
    expect((await evaluate(a.id, (await makeOffer(72)).id)).decision).toBe("ALLOW");
    await handleStripeEvent(charge("ch_2", "cus_b"));
    await handleStripeEvent(charge("ch_3", "cus_b")); // same card again — no duplicate rows
    expect(await prisma.paymentMethodFingerprint.count({ where: { fingerprint: "fp_card_1" } })).toBe(2);
    const result = await evaluate(a.id, (await makeOffer(72)).id);
    expect(result.fired.map((f) => f.rule)).toEqual(["SAME_CARD"]);
    expect(result.fired[0]!.evidence).toMatchObject({ last4: "4242", accountsOnCard: 2, max: 1 });
    expect((await handleStripeEvent({ id: "evt_nocard", type: "charge.succeeded", data: { object: { id: "ch_x", customer: "cus_unknown", payment_method_details: { card: { fingerprint: "fp_other" } } } } })).note).toMatch(/no member/);
  });

  it("review: approve releases a HELD redemption, deny denies it, flags can't be reviewed twice; ban closes everything", async () => {
    const staff = await createStaff("ADMIN");
    const m = await createMember();
    await age(m.id, 48);
    const held = await createRedemption(m.id);
    await prisma.redemption.update({ where: { id: held.id }, data: { status: "HELD" } });
    await recordDevice(m.id, "fp-ban", "UA");
    const f1 = await prisma.fraudFlag.create({ data: { memberId: m.id, rule: "OVERLAP", evidence: {}, redemptionId: held.id } });
    const f2 = await prisma.fraudFlag.create({ data: { memberId: m.id, rule: "SAME_CARD", evidence: {}, redemptionId: held.id } });
    await reviewFlag(f1.id, "APPROVED", { staffId: staff.id, note: "fine" });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("HELD"); // f2 still open
    await expect(reviewFlag(f1.id, "APPROVED", { staffId: staff.id })).rejects.toBeInstanceOf(ReviewError);
    await reviewFlag(f2.id, "APPROVED", { staffId: staff.id });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("ACTIVE");
    expect(await prisma.fraudFlag.findUniqueOrThrow({ where: { id: f1.id } })).toMatchObject({ status: "APPROVED", reviewedById: staff.id, reviewNote: "fine" });

    const held2 = await createRedemption(m.id);
    await prisma.redemption.update({ where: { id: held2.id }, data: { status: "HELD" } });
    const f3 = await prisma.fraudFlag.create({ data: { memberId: m.id, rule: "OVERLAP", evidence: {}, redemptionId: held2.id } });
    await reviewFlag(f3.id, "DENIED", { staffId: staff.id });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: held2.id } })).status).toBe("DENIED");

    const held3 = await createRedemption(m.id);
    await prisma.redemption.update({ where: { id: held3.id }, data: { status: "HELD" } });
    await prisma.fraudFlag.create({ data: { memberId: m.id, rule: "DEVICE_MAX_ACCOUNTS", evidence: {} } });
    await prisma.session.create({ data: { sessionToken: "s-ban", userId: m.id, expires: new Date(Date.now() + HOUR) } });
    await expect(banMember(m.id, { staffId: staff.id, reason: "" })).rejects.toBeInstanceOf(ReviewError);
    await banMember(m.id, { staffId: staff.id, reason: "multi-accounting" });
    const banned = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
    expect(banned.bannedAt).not.toBeNull();
    expect(banned.banReason).toBe("multi-accounting");
    expect(await prisma.fraudFlag.count({ where: { memberId: m.id, status: "OPEN" } })).toBe(0);
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: held3.id } })).status).toBe("DENIED");
    expect(await prisma.session.count({ where: { userId: m.id } })).toBe(0);
    await unbanMember(m.id);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).bannedAt).toBeNull();
  });
});
