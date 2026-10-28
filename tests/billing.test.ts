import { beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { runSeed } from "../prisma/seed-data";
import { handleStripeEvent } from "@/lib/stripe-webhook";
import {
  BillingError,
  addMonths,
  changeSubscriptionPlan,
  ensureFreeSubscription,
  getMembership,
  registerBillingWebhooks,
  runExpirePeriods,
  runMonthlyGrants,
  setBillingStripeForTests,
  setCancelAtPeriodEnd,
  startKeyPackCheckout,
  startSubscriptionCheckout,
  startTouristPassCheckout,
  type BillingStripe,
} from "@/domain/billing";
import { getBalance } from "@/domain/keys";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const DAY = 86_400_000;
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/** In-memory Stripe surface: records calls, returns ids. */
function fakeStripe() {
  const calls: { sessions: Stripe.Checkout.SessionCreateParams[]; subUpdates: [string, Stripe.SubscriptionUpdateParams][]; customers: number } = {
    sessions: [],
    subUpdates: [],
    customers: 0,
  };
  const stripe: BillingStripe = {
    customers: {
      async create() {
        calls.customers++;
        return { id: `cus_${calls.customers}` };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.sessions.push(params);
          return { id: `cs_${calls.sessions.length}`, url: `https://checkout.stripe.test/cs_${calls.sessions.length}` };
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        return { id, items: { data: [{ id: `si_${id}`, price: { id: "price_old" } }] } };
      },
      async update(id, params) {
        calls.subUpdates.push([id, params]);
        return {};
      },
    },
    billingPortal: { sessions: { async create() { return { url: "https://portal.stripe.test" }; } } },
  };
  return { stripe, calls };
}

/** Synthetic Stripe events in the 2025+ API shape (parent.*, items[].current_period_*, pricing.price_details). */
function sessionCompleted(id: string, meta: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { id: `evt_${id}`, type: "checkout.session.completed", data: { object: { id, metadata: meta, payment_status: "paid", ...extra } } };
}
function invoicePaid(id: string, subId: string, priceId: string, start: Date, end: Date, reason = "subscription_cycle", meta: Record<string, string> = {}) {
  return {
    id: `evt_${id}`,
    type: "invoice.paid",
    data: {
      object: {
        id,
        billing_reason: reason,
        parent: { subscription_details: { subscription: subId, metadata: meta } },
        lines: { data: [{ pricing: { price_details: { price: priceId } }, period: { start: sec(start), end: sec(end) } }] },
      },
    },
  };
}
function subscriptionEvent(type: string, subId: string, priceId: string, status: string, cancelAtPeriodEnd: boolean, start: Date, end: Date, evt = `${type}_${subId}_${status}_${cancelAtPeriodEnd}`) {
  return {
    id: `evt_${evt}`,
    type,
    data: {
      object: {
        id: subId,
        status,
        cancel_at_period_end: cancelAtPeriodEnd,
        items: { data: [{ id: `si_${subId}`, price: { id: priceId }, current_period_start: sec(start), current_period_end: sec(end) }] },
      },
    },
  };
}

async function priceFor(tier: string, period: string) {
  return prisma.planPrice.findFirstOrThrow({ where: { plan: { period: period as never, tier: { code: tier as never } } }, include: { plan: true } });
}

describe("billing", () => {
  const fake = fakeStripe();
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    // Pretend the price sync ran: give every paid price/pack a Stripe id.
    const prices = await prisma.planPrice.findMany({ where: { amountCents: { gt: 0 } } });
    for (const p of prices) await prisma.planPrice.update({ where: { id: p.id }, data: { stripePriceId: `price_${p.id}` } });
    const packs = await prisma.keyPack.findMany();
    for (const k of packs) await prisma.keyPack.update({ where: { id: k.id }, data: { stripePriceId: `price_${k.id}` } });
    setBillingStripeForTests(fake.stripe);
    registerBillingWebhooks();
  });

  describe("FREE tier", () => {
    it("every member starts on a FREE subscription with the tier's monthly keys, idempotently", async () => {
      const m = await createMember();
      const sub = await ensureFreeSubscription(m.id);
      expect(sub).toMatchObject({ stripeSubscriptionId: null, status: "ACTIVE" });
      expect(sub!.plan.tier.code).toBe("FREE");
      expect(sub!.nextGrantAt?.getTime()).toBe(sub!.currentPeriodEnd.getTime());
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 2, planKeysExpireAt: sub!.currentPeriodEnd });
      expect((await ensureFreeSubscription(m.id))!.id).toBe(sub!.id);
      expect(await prisma.subscription.count({ where: { memberId: m.id } })).toBe(1);
      const membership = await getMembership(m.id);
      expect(membership).toMatchObject({ tierCode: "FREE", isPaid: false, canBuyPacks: false, keysPerMonth: 2 });
    });

    it("FREE cannot buy key packs", async () => {
      const m = await createMember();
      const pack = await prisma.keyPack.findFirstOrThrow();
      await expect(startKeyPackCheckout(m.id, pack.id)).rejects.toBeInstanceOf(BillingError);
      await expect(startKeyPackCheckout(m.id, pack.id)).rejects.toThrow(/paid members/);
    });

    it("the monthly job rolls the FREE month: expires the remainder and grants again", async () => {
      const m = await createMember();
      const sub = (await ensureFreeSubscription(m.id))!;
      const later = new Date(sub.currentPeriodEnd.getTime() + DAY);
      expect(await runMonthlyGrants({ now: later, memberId: m.id })).toMatchObject({ granted: 1 });
      const rolled = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(rolled.currentPeriodStart.getTime()).toBe(sub.currentPeriodEnd.getTime());
      expect(rolled.currentPeriodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 1).getTime());
      expect(await getBalance(m.id, { now: later })).toMatchObject({ planKeys: 2, planKeysExpireAt: rolled.currentPeriodEnd });
      const types = (await prisma.keyTransaction.findMany({ where: { memberId: m.id }, orderBy: { createdAt: "asc" } })).map((r) => r.type);
      expect(types).toEqual(["PLAN_GRANT", "EXPIRY", "PLAN_GRANT"]);
      // Idempotent: nothing due now.
      expect(await runMonthlyGrants({ now: later, memberId: m.id })).toMatchObject({ granted: 0 });
    });
  });

  describe("subscription checkout + webhooks (monthly)", () => {
    it("opens a subscription-mode session with the synced price and SIAPP metadata", async () => {
      const m = await createMember();
      const price = await priceFor("SOCIAL", "MONTHLY");
      const { url } = await startSubscriptionCheckout(m.id, price.id);
      expect(url).toMatch(/^https:\/\/checkout/);
      const params = fake.calls.sessions.at(-1)!;
      expect(params).toMatchObject({
        mode: "subscription",
        line_items: [{ price: price.stripePriceId, quantity: 1 }],
        metadata: { kind: "subscription", memberId: m.id, planId: price.planId },
        subscription_data: { metadata: { memberId: m.id, planId: price.planId } },
      });
      expect(params.customer).toMatch(/^cus_/);
      expect(await prisma.stripeCustomer.findUnique({ where: { memberId: m.id } })).not.toBeNull();
      // Customer is reused.
      const before = fake.calls.customers;
      await startSubscriptionCheckout(m.id, price.id);
      expect(fake.calls.customers).toBe(before);
      // Wrong kind of plan is refused.
      const tourist = await priceFor("REGULAR", "TOURIST_WEEK");
      await expect(startSubscriptionCheckout(m.id, tourist.id)).rejects.toBeInstanceOf(BillingError);
    });

    it("session.completed + invoice.paid (subscription_create) activate the plan, grant keys, retire FREE; replay is a no-op (invariant 11)", async () => {
      const m = await createMember();
      const free = (await ensureFreeSubscription(m.id))!;
      const price = await priceFor("SOCIAL", "MONTHLY");
      const start = new Date();
      const end = addMonths(start, 1);

      await handleStripeEvent(sessionCompleted("cs_sub1", { kind: "subscription", memberId: m.id, planId: price.planId }, { subscription: "sub_1", mode: "subscription" }));
      let sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_1" } });
      expect(sub).toMatchObject({ memberId: m.id, planId: price.planId, checkoutSessionId: "cs_sub1", status: "ACTIVE" });
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 2 }); // nothing granted until the invoice is paid

      const outcome = await handleStripeEvent(invoicePaid("in_1", "sub_1", price.stripePriceId!, start, end, "subscription_create"));
      expect(outcome.status).toBe("processed");
      sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_1" } });
      expect(sub.currentPeriodEnd.getTime()).toBe(Math.floor(end.getTime() / 1000) * 1000);
      expect(sub.firstPaidAt).not.toBeNull();
      expect(sub.nextGrantAt).toBeNull();
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30, purchasedKeys: 0 });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: free.id } })).status).toBe("EXPIRED");
      const membership = await getMembership(m.id);
      expect(membership).toMatchObject({ tierCode: "SOCIAL", isPaid: true, isRecurring: true, canBuyPacks: true, keysPerMonth: 30 });

      // Replay of the same event and a duplicate invoice with the same period: no double grant.
      expect((await handleStripeEvent(invoicePaid("in_1", "sub_1", price.stripePriceId!, start, end, "subscription_create"))).status).toBe("replay");
      await handleStripeEvent(invoicePaid("in_1_dup", "sub_1", price.stripePriceId!, start, end, "subscription_create"));
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 });
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "PLAN_GRANT", amount: 30 } })).toBe(1);
    });

    it("invoice.paid works when it arrives before session.completed (member resolved from metadata)", async () => {
      const m = await createMember();
      const price = await priceFor("REGULAR", "MONTHLY");
      const start = new Date();
      const end = addMonths(start, 1);
      await handleStripeEvent(invoicePaid("in_early", "sub_early", price.stripePriceId!, start, end, "subscription_create", { memberId: m.id, planId: price.planId }));
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_early" } });
      expect(sub.memberId).toBe(m.id);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 80 });
      await handleStripeEvent(sessionCompleted("cs_early", { kind: "subscription", memberId: m.id, planId: price.planId }, { subscription: "sub_early", mode: "subscription" }));
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).checkoutSessionId).toBe("cs_early");
      expect(await prisma.subscription.count({ where: { memberId: m.id, stripeSubscriptionId: { not: null } } })).toBe(1);
    });

    it("renewal (subscription_cycle) expires the previous remainder and grants the new period", async () => {
      const m = await createMember();
      await ensureFreeSubscription(m.id);
      const price = await priceFor("SOCIAL", "MONTHLY");
      const start = new Date();
      const end = addMonths(start, 1);
      await handleStripeEvent(invoicePaid("in_r1", "sub_r", price.stripePriceId!, start, end, "subscription_create", { memberId: m.id, planId: price.planId }));
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 });
      // Spend nothing; the renewal arrives — the unused 30 are lost, the new 30 land.
      const end2 = addMonths(end, 1);
      await handleStripeEvent(invoicePaid("in_r2", "sub_r", price.stripePriceId!, end, end2, "subscription_cycle"));
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_r" } })).currentPeriodEnd.getTime()).toBe(Math.floor(end2.getTime() / 1000) * 1000);
      const rows = await prisma.keyTransaction.findMany({ where: { memberId: m.id }, orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => [r.type, r.amount])).toEqual([
        ["PLAN_GRANT", 2],
        ["EXPIRY", -2],
        ["PLAN_GRANT", 30],
        ["EXPIRY", -30],
        ["PLAN_GRANT", 30],
      ]);
    });

    it("payment_failed → PAST_DUE, a paid cycle restores ACTIVE, subscription.updated mirrors the cancel flag, deleted → back to FREE", async () => {
      const m = await createMember();
      const price = await priceFor("SOCIAL", "MONTHLY");
      const start = new Date();
      const end = addMonths(start, 1);
      await handleStripeEvent(invoicePaid("in_f1", "sub_f", price.stripePriceId!, start, end, "subscription_create", { memberId: m.id, planId: price.planId }));

      await handleStripeEvent({ id: "evt_fail", type: "invoice.payment_failed", data: { object: { id: "in_f2", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_f" } } } } });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_f" } })).status).toBe("PAST_DUE");

      await handleStripeEvent(subscriptionEvent("customer.subscription.updated", "sub_f", price.stripePriceId!, "active", true, start, end));
      let sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_f" } });
      expect(sub).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: true });

      await handleStripeEvent({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_f", status: "canceled" } } });
      sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_f" } });
      expect(sub.status).toBe("CANCELLED");
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 2 }); // paid keys expired, fresh FREE month granted
      const membership = await getMembership(m.id);
      expect(membership.tierCode).toBe("FREE");
      expect(membership.subscription!.stripeSubscriptionId).toBeNull();
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "EXPIRY", amount: -30 } })).toBe(1);
    });
  });

  describe("quarterly cadence", () => {
    it("grants the first month on invoice.paid, then one month at a time from the job, then the renewal", async () => {
      const m = await createMember();
      const price = await priceFor("REGULAR", "QUARTERLY");
      const start = new Date();
      const end = addMonths(start, 3);
      await handleStripeEvent(invoicePaid("in_q1", "sub_q", price.stripePriceId!, start, end, "subscription_create", { memberId: m.id, planId: price.planId }));
      let sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: "sub_q" } });
      const m1 = addMonths(new Date(Math.floor(start.getTime() / 1000) * 1000), 1);
      expect(sub.nextGrantAt?.getTime()).toBe(m1.getTime());
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 80, planKeysExpireAt: m1 });

      // Nothing due before the anniversary.
      expect(await runMonthlyGrants({ now: new Date(m1.getTime() - DAY), memberId: m.id })).toMatchObject({ granted: 0 });

      // Month 2: previous remainder expires, new grant, next anniversary scheduled.
      const t2 = new Date(m1.getTime() + 3600_000);
      expect(await runMonthlyGrants({ now: t2, memberId: m.id })).toMatchObject({ granted: 1 });
      sub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      const m2 = addMonths(m1, 1);
      expect(sub.nextGrantAt?.getTime()).toBe(m2.getTime());
      expect(await getBalance(m.id, { now: t2 })).toMatchObject({ planKeys: 80, planKeysExpireAt: m2 });

      // Month 3: last month of the period — the next grant is the renewal, so nextGrantAt clears.
      const t3 = new Date(m2.getTime() + 3600_000);
      expect(await runMonthlyGrants({ now: t3, memberId: m.id })).toMatchObject({ granted: 1 });
      sub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(sub.nextGrantAt).toBeNull();
      expect(await getBalance(m.id, { now: t3 })).toMatchObject({ planKeys: 80, planKeysExpireAt: sub.currentPeriodEnd });
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "PLAN_GRANT", amount: 80 } })).toBe(3);

      // Renewal invoice: new quarter, first month again.
      const end2 = addMonths(end, 3);
      await handleStripeEvent(invoicePaid("in_q2", "sub_q", price.stripePriceId!, end, end2, "subscription_cycle"));
      sub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(sub.nextGrantAt?.getTime()).toBe(addMonths(new Date(Math.floor(end.getTime() / 1000) * 1000), 1).getTime());
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "PLAN_GRANT", amount: 80 } })).toBe(4);
      // A PAST_DUE subscription is skipped by the job.
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE", nextGrantAt: new Date(0) } });
      expect(await runMonthlyGrants({ memberId: m.id })).toMatchObject({ granted: 0, skipped: 1 });
    });
  });

  describe("plan changes and cancellation", () => {
    it("changeSubscriptionPlan swaps the Stripe price with proration and grants nothing until the next period", async () => {
      const m = await createMember();
      const social = await priceFor("SOCIAL", "MONTHLY");
      const plus = await priceFor("PLUS", "MONTHLY");
      const start = new Date();
      const end = addMonths(start, 1);
      await handleStripeEvent(invoicePaid("in_c1", "sub_c", social.stripePriceId!, start, end, "subscription_create", { memberId: m.id, planId: social.planId }));

      await changeSubscriptionPlan(m.id, plus.id);
      const [id, params] = fake.calls.subUpdates.at(-1)!;
      expect(id).toBe("sub_c");
      expect(params).toMatchObject({ items: [{ id: "si_sub_c", price: plus.stripePriceId }], proration_behavior: "create_prorations" });
      expect((await getMembership(m.id)).tierCode).toBe("PLUS");
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 }); // still this period's SOCIAL keys
      await expect(changeSubscriptionPlan(m.id, plus.id)).rejects.toThrow(/already on that plan/);

      // Stripe's prorated invoice for the change does not grant.
      await handleStripeEvent(invoicePaid("in_c_upd", "sub_c", plus.stripePriceId!, start, end, "subscription_update"));
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 });
      // The next cycle grants PLUS keys.
      await handleStripeEvent(invoicePaid("in_c2", "sub_c", plus.stripePriceId!, end, addMonths(end, 1), "subscription_cycle"));
      expect(await getBalance(m.id, { now: new Date(end.getTime() + 1000) })).toMatchObject({ planKeys: 150 });

      await setCancelAtPeriodEnd(m.id, true);
      expect(fake.calls.subUpdates.at(-1)![1]).toMatchObject({ cancel_at_period_end: true });
      expect((await getMembership(m.id)).subscription!.cancelAtPeriodEnd).toBe(true);
      await setCancelAtPeriodEnd(m.id, false);
      expect((await getMembership(m.id)).subscription!.cancelAtPeriodEnd).toBe(false);

      // A second checkout while subscribed is refused.
      await expect(startSubscriptionCheckout(m.id, social.id)).rejects.toThrow(/change your plan/);
    });

    it("a member without a subscription cannot change or cancel", async () => {
      const m = await createMember();
      const plus = await priceFor("PLUS", "MONTHLY");
      await expect(changeSubscriptionPlan(m.id, plus.id)).rejects.toBeInstanceOf(BillingError);
      await expect(setCancelAtPeriodEnd(m.id, true)).rejects.toBeInstanceOf(BillingError);
    });
  });

  describe("key packs", () => {
    it("paid members buy packs via a payment-mode session; the webhook grants purchased keys once", async () => {
      const m = await createMember();
      const price = await priceFor("SOCIAL", "MONTHLY");
      await handleStripeEvent(invoicePaid("in_p1", "sub_p", price.stripePriceId!, new Date(), addMonths(new Date(), 1), "subscription_create", { memberId: m.id, planId: price.planId }));
      const pack = await prisma.keyPack.findFirstOrThrow({ where: { keys: 50 } });
      await startKeyPackCheckout(m.id, pack.id);
      expect(fake.calls.sessions.at(-1)).toMatchObject({ mode: "payment", line_items: [{ price: pack.stripePriceId }], metadata: { kind: "key_pack", memberId: m.id, keyPackId: pack.id } });

      // Unpaid completion (async method) waits; paid grants; replays and duplicates don't.
      await handleStripeEvent(sessionCompleted("cs_pack", { kind: "key_pack", memberId: m.id, keyPackId: pack.id }, { payment_status: "unpaid" }));
      expect(await getBalance(m.id)).toMatchObject({ purchasedKeys: 0 });
      await handleStripeEvent({ id: "evt_pack_async", type: "checkout.session.async_payment_succeeded", data: { object: { id: "cs_pack", metadata: { kind: "key_pack", memberId: m.id, keyPackId: pack.id }, payment_status: "paid" } } });
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30, purchasedKeys: 50 });
      await handleStripeEvent(sessionCompleted("cs_pack", { kind: "key_pack", memberId: m.id, keyPackId: pack.id }));
      expect(await getBalance(m.id)).toMatchObject({ purchasedKeys: 50 });
      const row = await prisma.keyTransaction.findFirstOrThrow({ where: { memberId: m.id, type: "PACK_PURCHASE" } });
      expect(row.reference).toBe("pack:cs_pack");
    });
  });

  describe("tourist pass", () => {
    it("one-off checkout → 7-day TOURIST_WEEK subscription without a Stripe subscription, expired by the job", async () => {
      const m = await createMember();
      await ensureFreeSubscription(m.id);
      await expect(startTouristPassCheckout(m.id)).rejects.toThrow(/ID first/); // spec §3: ID photo required
      await prisma.member.update({ where: { id: m.id }, data: { idPhotoUrl: "memory://id", idPhotoUploadedAt: new Date() } });
      await startTouristPassCheckout(m.id);
      const params = fake.calls.sessions.at(-1)!;
      expect(params.mode).toBe("payment");
      const meta = params.metadata as Record<string, string>;
      expect(meta.kind).toBe("tourist_pass");

      const t0 = new Date();
      await handleStripeEvent(sessionCompleted("cs_tour", meta));
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { checkoutSessionId: "cs_tour" }, include: { plan: true } });
      expect(sub.plan.period).toBe("TOURIST_WEEK");
      expect(sub.stripeSubscriptionId).toBeNull();
      expect(sub.firstPaidAt).toBeNull(); // never counts for referral vesting
      expect(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()).toBe(7 * DAY);
      expect(sub.currentPeriodEnd.getTime()).toBeGreaterThanOrEqual(t0.getTime() + 7 * DAY - 5000);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 50, planKeysExpireAt: sub.currentPeriodEnd });
      const membership = await getMembership(m.id);
      expect(membership).toMatchObject({ isPaid: true, isTourist: true, isRecurring: false, canBuyPacks: true });
      await expect(startTouristPassCheckout(m.id)).rejects.toThrow(/already have/);

      // Replay / duplicate completion: one pass.
      await handleStripeEvent(sessionCompleted("cs_tour", meta));
      expect(await prisma.subscription.count({ where: { memberId: m.id, plan: { period: "TOURIST_WEEK" } } })).toBe(1);

      // Day 8: pass expires, keys gone, back on FREE.
      const day8 = new Date(sub.currentPeriodEnd.getTime() + 3600_000);
      expect(await runExpirePeriods({ now: day8, memberId: m.id })).toMatchObject({ expiredPasses: 1 });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("EXPIRED");
      const after = await getMembership(m.id, { now: day8 });
      expect(after.tierCode).toBe("FREE");
      expect(await getBalance(m.id, { now: day8 })).toMatchObject({ planKeys: 2 });
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "EXPIRY", amount: -50 } })).toBe(1);
      expect(await runExpirePeriods({ now: day8, memberId: m.id })).toMatchObject({ expiredPasses: 0 });
    });
  });
});
