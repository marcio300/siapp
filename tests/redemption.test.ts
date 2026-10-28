import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { handleStripeEvent } from "@/lib/stripe-webhook";
import { grantPlanKeys, grantPurchasedKeys, getBalance } from "@/domain/keys";
import { setBillingStripeForTests, type BillingStripe } from "@/domain/billing";
import { reviewFlag } from "@/domain/fraud";
import {
  RedemptionError,
  cancelRedemption,
  expirePendingPayments,
  expireWaitlistClaims,
  explainEligibility,
  joinWaitlist,
  markNoShows,
  redeem,
  refundEventRedemptions,
  registerRedemptionWebhooks,
  startRedemptionPayment,
  verifyQrSignature,
} from "@/domain/redemption";
import { createEvent, addOffer, setEventStatus, type OfferInput } from "@/domain/events";
import { createProducer } from "@/domain/producers";
import { prisma, resetDatabase } from "./db";
import { createMember, createStaff } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A verified, paid (SOCIAL) member with `keys` plan keys. */
async function readyMember(keys = 100, tier: "SOCIAL" | "PLUS" | "FREE" = "SOCIAL") {
  const m = await createMember();
  await prisma.member.update({ where: { id: m.id }, data: { emailVerified: new Date(), onboardedAt: new Date(), selfieUploadedAt: new Date(), selfieUrl: "memory://selfie", name: "Ana", createdAt: new Date(Date.now() - 3 * DAY) } });
  const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: tier } } });
  await prisma.subscription.create({ data: { memberId: m.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), stripeSubscriptionId: tier === "FREE" ? null : `sub_${m.id}` } });
  if (keys > 0) await grantPlanKeys(m.id, keys, new Date(Date.now() + 30 * DAY));
  return m;
}

let producerId: string;
async function publishedEvent(startInHours = 72, offers: OfferInput[] = [{ name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 10 }]) {
  const start = new Date(Date.now() + startInHours * HOUR);
  const { event } = await createEvent({ producerId, title: `E${start.getTime()}`, startsAt: { date: start.toISOString().slice(0, 10), time: `${String(start.getUTCHours()).padStart(2, "0")}:${String(start.getUTCMinutes()).padStart(2, "0")}` }, endsAt: { date: new Date(start.getTime() + 5 * HOUR).toISOString().slice(0, 10), time: `${String((start.getUTCHours() + 5) % 24).padStart(2, "0")}:00` } });
  const created = [];
  for (const o of offers) created.push(await addOffer(event.id, o));
  await setEventStatus(event.id, "PUBLISHED");
  const fresh = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
  return { event: fresh, offers: created };
}

function fakeStripe() {
  const calls = { sessions: [] as unknown[], refunds: [] as unknown[] };
  const stripe: BillingStripe = {
    customers: { async create() { return { id: "cus_r" }; } },
    checkout: { sessions: { async create(params) { calls.sessions.push(params); return { id: `cs_r${calls.sessions.length}`, url: "https://checkout.test" }; } } },
    subscriptions: { async retrieve(id) { return { id, items: { data: [] } }; }, async update() { return {}; } },
    billingPortal: { sessions: { async create() { return { url: "" }; } } },
    refunds: { async create(params) { calls.refunds.push(params); return { id: `re_${calls.refunds.length}` }; } },
  };
  return { stripe, calls };
}

describe("redemption", () => {
  const fake = fakeStripe();
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    producerId = (await createProducer({ name: "Lux", cityId: s.cityId })).id;
    setBillingStripeForTests(fake.stripe);
    registerRedemptionWebhooks();
  });

  it("free offer: ACTIVE with ticket, keys spent plan-first, confirmation sent; typed refusals", async () => {
    const m = await readyMember(100);
    const { event, offers } = await publishedEvent(72, [{ name: "Std", type: "FREE_TICKET", keyCost: 25, allocationType: "CAPPED", capacity: 10, plusOneAllowed: true, plusOneExtraKeyCost: "5" }]);
    const r = await redeem(m.id, offers[0]!.id, { plusOneName: "Bo" });
    expect(r).toMatchObject({ status: "ACTIVE", keyCost: 30, cashCents: 0, fromPlan: 30, fromPurchased: 0 });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { redemptionId: r.redemptionId } });
    expect(ticket).toMatchObject({ memberName: "Ana", photoSnapshotUrl: "memory://selfie", plusOneName: "Bo" });
    expect(ticket.qrPayload).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyQrSignature(ticket.qrPayload, ticket.signature)).toBe(true);
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } });
    expect(row.cancelDeadlineAt.getTime()).toBe(event.startsAt.getTime() - 24 * HOUR);
    expect(await getBalance(m.id)).toMatchObject({ total: 70 });
    // max per member
    await expect(redeem(m.id, offers[0]!.id)).rejects.toMatchObject({ reason: "MAX_PER_MEMBER" });
    // not verified / FREE tier / insufficient keys / +1 not allowed / not published
    const unverified = await createMember();
    await expect(redeem(unverified.id, offers[0]!.id)).rejects.toMatchObject({ reason: "NOT_VERIFIED" });
    const free = await readyMember(50, "FREE");
    await expect(redeem(free.id, offers[0]!.id)).rejects.toMatchObject({ reason: "TIER_NOT_ALLOWED" });
    const poor = await readyMember(5);
    await expect(redeem(poor.id, offers[0]!.id)).rejects.toMatchObject({ reason: "INSUFFICIENT_KEYS", detail: { needed: 25, have: 5 } });
    const { offers: noPlus } = await publishedEvent(200);
    await expect(redeem(m.id, noPlus[0]!.id, { plusOneName: "X" })).rejects.toMatchObject({ reason: "PLUS_ONE_NOT_ALLOWED" });
    await setEventStatus(event.id, "DRAFT");
    await expect(redeem(poor.id, offers[0]!.id)).rejects.toMatchObject({ reason: "EVENT_NOT_OPEN" });
    expect((await explainEligibility(poor.id, offers[0]!.id))).toMatchObject({ ok: false, reason: "EVENT_NOT_OPEN" });
  });

  it("invariant 3: 100 concurrent redemptions on a capacity-10 offer yield exactly 10", async () => {
    const members = await Promise.all(Array.from({ length: 100 }, () => readyMember(20)));
    const { offers } = await publishedEvent(96);
    const results = await Promise.allSettled(members.map((m) => redeem(m.id, offers[0]!.id)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    const unexpected = failed.filter((f) => !(f.reason instanceof RedemptionError));
    if (unexpected.length > 0) console.error("unexpected failure:", unexpected[0]!.reason);
    expect(unexpected).toHaveLength(0);
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(90);
    for (const f of failed) expect(f.reason).toBeInstanceOf(RedemptionError);
    expect(failed.every((f) => f.reason.reason === "SOLD_OUT")).toBe(true);
    expect(await prisma.redemption.count({ where: { offerId: offers[0]!.id, status: "ACTIVE" } })).toBe(10);
    expect(await prisma.ticket.count({ where: { redemption: { offerId: offers[0]!.id } } })).toBe(10);
    // Nobody lost keys without a seat: 90 still have 20, 10 have 10.
    const balances = await Promise.all(members.map((m) => getBalance(m.id)));
    expect(balances.filter((b) => b.total === 20)).toHaveLength(90);
    expect(balances.filter((b) => b.total === 10)).toHaveLength(10);
  }, 120_000);

  it("invariant 5: private sale rejects a non-eligible tier before opensAt and accepts after", async () => {
    const { event, offers } = await publishedEvent(120, [{ name: "Early", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 50, privateSaleTiers: ["PLUS"], privateSaleHoursBefore: "48" }]);
    const opensAt = (await prisma.offer.findUniqueOrThrow({ where: { id: offers[0]!.id } })).privateSaleOpensAt!;
    expect(opensAt.getTime()).toBe(event.publishedAt!.getTime() + 48 * HOUR);
    const social = await readyMember(50, "SOCIAL");
    const plus = await readyMember(50, "PLUS");
    await expect(redeem(social.id, offers[0]!.id)).rejects.toMatchObject({ reason: "PRIVATE_SALE", detail: { opensAt: opensAt.toISOString(), tiers: ["PLUS"] } });
    expect((await redeem(plus.id, offers[0]!.id)).status).toBe("ACTIVE");
    const later = new Date(opensAt.getTime() + 60_000);
    expect((await redeem(social.id, offers[0]!.id, {}, { now: later })).status).toBe("ACTIVE");
  });

  it("invariant 6: cancel at 24 h + 1 min succeeds and refunds keys; at 24 h − 1 min it is refused", async () => {
    const a = await readyMember(50);
    const b = await readyMember(50);
    const { event, offers } = await publishedEvent(72);
    const ra = await redeem(a.id, offers[0]!.id);
    const rb = await redeem(b.id, offers[0]!.id);
    const deadline = event.startsAt.getTime() - 24 * HOUR;
    const res = await cancelRedemption(ra.redemptionId, a.id, { now: new Date(deadline - 60_000) });
    expect(res).toEqual({ keysRefunded: 10, cashRefundedCents: 0 });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: ra.redemptionId } })).status).toBe("CANCELLED");
    expect(await getBalance(a.id)).toMatchObject({ total: 50 });
    expect(await prisma.keyTransaction.count({ where: { redemptionId: ra.redemptionId, type: "CANCELLATION_REFUND" } })).toBe(1);
    await expect(cancelRedemption(rb.redemptionId, b.id, { now: new Date(deadline + 60_000) })).rejects.toMatchObject({ reason: "TOO_LATE" });
    expect(await getBalance(b.id)).toMatchObject({ total: 40 });
    // Another member can't cancel it; double cancel refused.
    await expect(cancelRedemption(rb.redemptionId, a.id)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(cancelRedemption(ra.redemptionId, a.id)).rejects.toMatchObject({ reason: "BAD_STATE" });
    // Per-offer override: 2 h window.
    const { event: e2, offers: o2 } = await publishedEvent(72, [{ name: "Late", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 5, cancellationWindowHours: "2" }]);
    const rc = await redeem(a.id, o2[0]!.id);
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: rc.redemptionId } })).cancelDeadlineAt.getTime()).toBe(e2.startsAt.getTime() - 2 * HOUR);
  });

  it("invariant 7: the no-show job forfeits keys, writes no refund, records attendance, finishes the event", async () => {
    const m = await readyMember(50);
    const { event, offers } = await publishedEvent(2);
    const r = await redeem(m.id, offers[0]!.id);
    expect(await markNoShows({ now: new Date(event.endsAt.getTime() - 60_000) })).toEqual({ noShows: 0, finishedEvents: 0 });
    expect(await markNoShows({ now: new Date(event.endsAt.getTime() + 60_000) })).toEqual({ noShows: 1, finishedEvents: 1 });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).status).toBe("NO_SHOW");
    expect(await prisma.keyTransaction.count({ where: { redemptionId: r.redemptionId, type: "CANCELLATION_REFUND" } })).toBe(0);
    expect(await getBalance(m.id)).toMatchObject({ total: 40 });
    expect(await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: m.id } })).toMatchObject({ noShows: 1, shows: 0 });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("FINISHED");
    await expect(cancelRedemption(r.redemptionId, m.id)).rejects.toMatchObject({ reason: "BAD_STATE" });
  });

  it("discounted ticket: PENDING_PAYMENT holds the seat and the keys, Checkout session, webhook completes, cancel refunds cash", async () => {
    const m = await readyMember(50);
    const { offers } = await publishedEvent(72, [{ name: "Standard", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "20", discountPercent: "40", allocationType: "CAPPED", capacity: 1 }]);
    const r = await redeem(m.id, offers[0]!.id);
    expect(r).toMatchObject({ status: "PENDING_PAYMENT", cashCents: 1200, keyCost: 10, ticketId: null });
    expect(r.paymentExpiresAt!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await getBalance(m.id)).toMatchObject({ total: 40 });
    // The seat is held: a second member is SOLD_OUT.
    const other = await readyMember(50);
    await expect(redeem(other.id, offers[0]!.id)).rejects.toMatchObject({ reason: "SOLD_OUT" });

    const { url } = await startRedemptionPayment(r.redemptionId, m.id);
    expect(url).toBe("https://checkout.test");
    const params = fake.calls.sessions.at(-1) as { mode: string; line_items: { price_data: { unit_amount: number } }[]; metadata: Record<string, string> };
    expect(params.mode).toBe("payment");
    expect(params.line_items[0]!.price_data.unit_amount).toBe(1200);
    expect(params.metadata).toMatchObject({ kind: "redemption", redemptionId: r.redemptionId });
    const sessionId = (await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).stripeCheckoutSessionId!;

    const outcome = await handleStripeEvent({ id: `evt_${sessionId}`, type: "checkout.session.completed", data: { object: { id: sessionId, payment_status: "paid", payment_intent: "pi_123", metadata: { kind: "redemption", memberId: m.id, redemptionId: r.redemptionId } } } });
    expect(outcome.note).toContain("completed");
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId }, include: { ticket: true } });
    expect(row).toMatchObject({ status: "ACTIVE", stripePaymentIntentId: "pi_123", paymentExpiresAt: null });
    expect(row.ticket).not.toBeNull();
    // Replay: no second ticket, no error.
    await handleStripeEvent({ id: `evt_${sessionId}_dup`, type: "checkout.session.completed", data: { object: { id: sessionId, payment_status: "paid", payment_intent: "pi_123", metadata: { kind: "redemption", memberId: m.id, redemptionId: r.redemptionId } } } });
    expect(await prisma.ticket.count({ where: { redemptionId: r.redemptionId } })).toBe(1);

    const res = await cancelRedemption(r.redemptionId, m.id);
    expect(res).toEqual({ keysRefunded: 10, cashRefundedCents: 1200 });
    expect(fake.calls.refunds.at(-1)).toMatchObject({ payment_intent: "pi_123", amount: 1200 });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).stripeRefundId).toMatch(/^re_/);
    expect(await getBalance(m.id)).toMatchObject({ total: 50 });
  });

  it("PENDING_PAYMENT expiry releases the seat and refunds the keys; a late payment is refunded", async () => {
    const m = await readyMember(50);
    const { offers } = await publishedEvent(72, [{ name: "Standard", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "10", discountPercent: "50", allocationType: "CAPPED", capacity: 1 }]);
    const r = await redeem(m.id, offers[0]!.id);
    const other = await readyMember(50);
    await expect(redeem(other.id, offers[0]!.id)).rejects.toMatchObject({ reason: "SOLD_OUT" });
    expect(await expirePendingPayments({ now: new Date(r.paymentExpiresAt!.getTime() - 1000) })).toEqual({ expired: 0 });
    expect(await expirePendingPayments({ now: new Date(r.paymentExpiresAt!.getTime() + 1000) })).toEqual({ expired: 1 });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).status).toBe("EXPIRED");
    expect(await getBalance(m.id)).toMatchObject({ total: 50 });
    expect((await redeem(other.id, offers[0]!.id)).status).toBe("PENDING_PAYMENT");
    // Money that arrives after expiry goes straight back.
    const before = fake.calls.refunds.length;
    await handleStripeEvent({ id: `evt_late_${r.redemptionId}`, type: "checkout.session.completed", data: { object: { id: "cs_late", payment_status: "paid", payment_intent: "pi_late", metadata: { kind: "redemption", memberId: m.id, redemptionId: r.redemptionId } } } });
    expect(fake.calls.refunds.length).toBe(before + 1);
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).stripeRefundId).toBeTruthy();
  });

  it("HELD counts against capacity; approval releases with a ticket, denial refunds keys and frees the seat", async () => {
    const staff = await createStaff("ADMIN");
    const suspicious = await readyMember(50);
    await prisma.member.update({ where: { id: suspicious.id }, data: { createdAt: new Date() } }); // brand-new account
    const { offers } = await publishedEvent(72, [{ name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 1 }]);
    // Three prior redemptions in the first hour → VELOCITY_FIRST_HOUR review on the next.
    for (let i = 0; i < 3; i++) await redeem(suspicious.id, (await publishedEvent(300 + i * 10)).offers[0]!.id);
    const r = await redeem(suspicious.id, offers[0]!.id);
    expect(r.status).toBe("HELD");
    expect(r.ticketId).toBeNull();
    const flag = await prisma.fraudFlag.findFirstOrThrow({ where: { memberId: suspicious.id, rule: "VELOCITY_FIRST_HOUR", status: "OPEN" } });
    expect(flag.redemptionId).toBe(r.redemptionId);
    const other = await readyMember(50);
    await expect(redeem(other.id, offers[0]!.id)).rejects.toMatchObject({ reason: "SOLD_OUT" });

    await reviewFlag(flag.id, "APPROVED", { staffId: staff.id });
    const released = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId }, include: { ticket: true } });
    expect(released.status).toBe("ACTIVE");
    expect(released.ticket).not.toBeNull();

    // Denial path on a fresh HELD redemption.
    const { offers: o2 } = await publishedEvent(400, [{ name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 1 }]);
    const r2 = await redeem(suspicious.id, o2[0]!.id);
    expect(r2.status).toBe("HELD");
    const before = (await getBalance(suspicious.id)).total;
    const flag2 = await prisma.fraudFlag.findFirstOrThrow({ where: { redemptionId: r2.redemptionId, status: "OPEN" } });
    await reviewFlag(flag2.id, "DENIED", { staffId: staff.id });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r2.redemptionId } })).status).toBe("DENIED");
    expect((await getBalance(suspicious.id)).total).toBe(before + 10);
    expect((await redeem(other.id, o2[0]!.id)).status).toBe("ACTIVE");
  });

  it("overlap is a hard refusal with the other event named", async () => {
    const m = await readyMember(100);
    const { event: first, offers: o1 } = await publishedEvent(72);
    await redeem(m.id, o1[0]!.id);
    const { offers: o2 } = await publishedEvent(74);
    await expect(redeem(m.id, o2[0]!.id)).rejects.toMatchObject({ reason: "OVERLAP", detail: { otherEventTitle: first.title } });
    const { offers: o3 } = await publishedEvent(80);
    expect((await redeem(m.id, o3[0]!.id)).status).toBe("ACTIVE");
  });

  it("waitlist: sold out → join → cancellation reserves the seat for the first in line, claim window expires to the next", async () => {
    const holder = await readyMember(50);
    const w1 = await readyMember(50);
    const w2 = await readyMember(50);
    const intruder = await readyMember(50);
    const { offers } = await publishedEvent(72, [{ name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 1 }]);
    const offerId = offers[0]!.id;
    await expect(joinWaitlist(w1.id, offerId)).rejects.toMatchObject({ reason: "BAD_STATE" }); // still spots
    const held = await redeem(holder.id, offerId);
    await joinWaitlist(w1.id, offerId);
    await joinWaitlist(w2.id, offerId);
    await expect(redeem(w1.id, offerId)).rejects.toMatchObject({ reason: "SOLD_OUT" });

    const t0 = new Date();
    await cancelRedemption(held.redemptionId, holder.id, { now: t0 });
    const e1 = await prisma.waitlistEntry.findUniqueOrThrow({ where: { offerId_memberId: { offerId, memberId: w1.id } } });
    expect(e1.status).toBe("NOTIFIED");
    expect(e1.claimBy!.getTime()).toBe(t0.getTime() + 60 * 60_000);
    // The seat is reserved for w1: others are told it's waitlist-only.
    await expect(redeem(intruder.id, offerId, {}, { now: new Date(t0.getTime() + 1000) })).rejects.toMatchObject({ reason: "WAITLIST_ONLY" });
    // w1 doesn't claim in time → w2 is notified; w1 expired.
    expect(await expireWaitlistClaims({ now: new Date(e1.claimBy!.getTime() + 1000) })).toEqual({ expired: 1 });
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e1.id } })).status).toBe("EXPIRED");
    const e2 = await prisma.waitlistEntry.findUniqueOrThrow({ where: { offerId_memberId: { offerId, memberId: w2.id } } });
    expect(e2.status).toBe("NOTIFIED");
    // w2 claims: redeem succeeds and the entry is CLAIMED.
    const claim = await redeem(w2.id, offerId, {}, { now: new Date(e1.claimBy!.getTime() + 2000) });
    expect(claim.status).toBe("ACTIVE");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e2.id } })).status).toBe("CLAIMED");
    await expect(redeem(intruder.id, offerId)).rejects.toMatchObject({ reason: "SOLD_OUT" });
  });

  it("cancelling an event refunds every live redemption and closes the waitlist", async () => {
    const a = await readyMember(50);
    const b = await readyMember(50);
    const { event, offers } = await publishedEvent(72, [{ name: "Standard", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "10", discountPercent: "0", allocationType: "CAPPED", capacity: 2 }]);
    const ra = await redeem(a.id, offers[0]!.id);
    await prisma.redemption.update({ where: { id: ra.redemptionId }, data: { status: "ACTIVE", stripePaymentIntentId: "pi_evt_a" } });
    await redeem(b.id, offers[0]!.id); // pending payment
    await setEventStatus(event.id, "CANCELLED");
    expect(await refundEventRedemptions(event.id)).toEqual({ refunded: 2 });
    expect(await prisma.redemption.count({ where: { eventId: event.id, status: "CANCELLED" } })).toBe(2);
    expect(fake.calls.refunds.at(-1)).toMatchObject({ payment_intent: "pi_evt_a", amount: 1000 });
    expect(await getBalance(a.id)).toMatchObject({ total: 50 });
    expect(await getBalance(b.id)).toMatchObject({ total: 50 });
    expect(await refundEventRedemptions(event.id)).toEqual({ refunded: 0 });
  });
});
