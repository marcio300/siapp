import type { Plan, Prisma, PrismaClient, Subscription, Tier } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { expirePlanKeys, grantPlanKeys } from "@/domain/keys";
import { BillingError } from "./errors";
import { addDays, addMonths, isRecurring, monthlyGrantWindow, nominalPeriodEnd, TOURIST_PASS_DAYS } from "./periods";

/**
 * Subscription state machine + key grants (docs/DATA_MODEL.md "Subscription",
 * spec §2–3). Stripe is mirrored, never trusted from the client: the only
 * writers are the webhook handlers (./webhooks.ts), the two jobs below and
 * the FREE-tier bootstrap.
 *
 * Grant cadence: monthly plans are granted by `invoice.paid`; quarterly/
 * yearly plans get the first month on `invoice.paid` and the following months
 * from `runMonthlyGrants` via `nextGrantAt`; FREE rolls its own month with the
 * same job. Every grant carries a unique reference so replays are no-ops.
 */

export type PlanWithTier = Plan & { tier: Tier };
export type SubscriptionWithPlan = Subscription & { plan: PlanWithTier };

export interface Opts {
  /** A TransactionClient joins the caller's transaction (no extra pool connection). */
  db?: PrismaClient | Prisma.TransactionClient;
  now?: Date;
}

/** Job options: `memberId` narrows a run to one member (backoffice re-runs, tests). */
export interface JobOpts extends Opts {
  memberId?: string;
}

const LIVE: Subscription["status"][] = ["ACTIVE", "PAST_DUE"];

export function keysForPlan(plan: PlanWithTier): number {
  return plan.keysPerPeriod ?? plan.tier.keysPerMonth;
}

/** Status flags the UI and the pack-purchase rule need. */
export interface Membership {
  subscription: SubscriptionWithPlan | null;
  tierCode: Tier["code"];
  isPaid: boolean;
  isTourist: boolean;
  isRecurring: boolean;
  canBuyPacks: boolean;
  keysPerMonth: number;
}

export async function getMembership(memberId: string, opts: Opts = {}): Promise<Membership> {
  const db = opts.db ?? defaultPrisma;
  let sub = await db.subscription.findFirst({
    where: { memberId, status: { in: LIVE } },
    include: { plan: { include: { tier: true } } },
    orderBy: [{ stripeSubscriptionId: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  if (!sub) sub = await ensureFreeSubscription(memberId, opts);
  const tierCode = sub?.plan.tier.code ?? "FREE";
  const isTourist = sub?.plan.period === "TOURIST_WEEK";
  const recurring = !!sub && isRecurring(sub.plan.period) && !!sub.stripeSubscriptionId;
  const isPaid = !!sub && tierCode !== "FREE";
  return {
    subscription: sub,
    tierCode,
    isPaid,
    isTourist,
    isRecurring: recurring,
    canBuyPacks: isPaid,
    keysPerMonth: sub ? keysForPlan(sub.plan) : 0,
  };
}

/**
 * FREE tier = a Subscription row with no Stripe id (spec §3). Created at
 * signup and again whenever a paid subscription ends. No-op when the member
 * already has a live subscription. Returns null when the FREE plan isn't
 * seeded (never breaks sign-in).
 */
export async function ensureFreeSubscription(memberId: string, opts: Opts = {}): Promise<SubscriptionWithPlan | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const live = await db.subscription.findFirst({
    where: { memberId, status: { in: LIVE } },
    include: { plan: { include: { tier: true } } },
  });
  if (live) return live;
  const freePlan = await db.plan.findFirst({
    where: { isActive: true, period: "MONTHLY", tier: { code: "FREE" } },
    include: { tier: true },
  });
  if (!freePlan) return null;
  const periodEnd = addMonths(now, 1);
  const sub = await db.subscription.create({
    data: {
      memberId,
      planId: freePlan.id,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextGrantAt: periodEnd,
    },
    include: { plan: { include: { tier: true } } },
  });
  await grantForSubPeriod(sub, now, periodEnd, { db, now });
  return sub;
}

/** Grant one month of keys for a subscription, idempotent per (sub, grantStart). */
async function grantForSubPeriod(sub: SubscriptionWithPlan, grantStart: Date, expiresAt: Date, opts: Opts) {
  const keys = keysForPlan(sub.plan);
  if (keys <= 0 || expiresAt <= (opts.now ?? new Date())) return null;
  return grantPlanKeys(
    sub.memberId,
    keys,
    expiresAt,
    { reference: `sub:${sub.id}:${grantStart.toISOString()}`, note: `${sub.plan.name} keys` },
    { db: opts.db, now: opts.now },
  );
}

/**
 * Any live subscription without a Stripe id (FREE, tourist, promo) ends the
 * moment a paid period lands: its keys expire and the row goes EXPIRED.
 */
async function supersedeLocalSubscriptions(memberId: string, keepId: string, opts: Required<Opts>) {
  const others = await opts.db.subscription.findMany({
    where: { memberId, id: { not: keepId }, stripeSubscriptionId: null, status: { in: LIVE } },
  });
  for (const other of others) {
    await expirePlanKeys(memberId, other.currentPeriodEnd, opts);
    await opts.db.subscription.update({ where: { id: other.id }, data: { status: "EXPIRED", nextGrantAt: null } });
  }
}

export interface PaidPeriodInput {
  memberId: string;
  stripeSubscriptionId: string;
  planId: string;
  periodStart: Date;
  periodEnd: Date;
  /** Only the first paid invoice starts the referral vesting clock. */
  invoiceId?: string;
  checkoutSessionId?: string;
}

/**
 * A paid period arrived (invoice.paid for subscription_create / cycle):
 * mirror the period, expire the previous period's remainder, grant this
 * period's first month, schedule the rest. Idempotent via the grant reference.
 */
export async function applyPaidPeriod(input: PaidPeriodInput, opts: Opts = {}): Promise<SubscriptionWithPlan> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const plan = await db.plan.findUnique({ where: { id: input.planId }, include: { tier: true } });
  if (!plan || !isRecurring(plan.period)) throw new BillingError(`Plan ${input.planId} is not a recurring plan`);

  const existing = await db.subscription.findUnique({ where: { stripeSubscriptionId: input.stripeSubscriptionId } });
  if (existing && existing.currentPeriodEnd <= input.periodStart) {
    // Renewal: the previous period's unused plan keys are lost (use it or lose it).
    await expirePlanKeys(input.memberId, existing.currentPeriodEnd, { db, now });
  }

  const { nextGrantAt, expiresAt } = monthlyGrantWindow(input.periodStart, input.periodEnd);
  const data = {
    planId: plan.id,
    status: "ACTIVE" as const,
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: input.periodEnd,
    nextGrantAt: plan.period === "MONTHLY" ? null : nextGrantAt,
    ...(input.checkoutSessionId ? { checkoutSessionId: input.checkoutSessionId } : {}),
  };
  const sub = existing
    ? await db.subscription.update({
        where: { id: existing.id },
        data: { ...data, firstPaidAt: existing.firstPaidAt ?? now },
        include: { plan: { include: { tier: true } } },
      })
    : await db.subscription.create({
        data: { ...data, memberId: input.memberId, stripeSubscriptionId: input.stripeSubscriptionId, firstPaidAt: now },
        include: { plan: { include: { tier: true } } },
      });

  await supersedeLocalSubscriptions(input.memberId, sub.id, { db, now });
  await grantForSubPeriod(sub, input.periodStart, plan.period === "MONTHLY" ? input.periodEnd : expiresAt, { db, now });
  return sub;
}

/** Link a Stripe subscription to a member right after Checkout, before/without the first invoice.paid. */
export async function linkStripeSubscription(
  input: { memberId: string; stripeSubscriptionId: string; planId: string; checkoutSessionId: string },
  opts: Opts = {},
): Promise<Subscription> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const existing = await db.subscription.findUnique({ where: { stripeSubscriptionId: input.stripeSubscriptionId } });
  if (existing) {
    if (existing.checkoutSessionId) return existing;
    return db.subscription.update({ where: { id: existing.id }, data: { checkoutSessionId: input.checkoutSessionId } });
  }
  const plan = await db.plan.findUniqueOrThrow({ where: { id: input.planId } });
  return db.subscription.create({
    data: {
      memberId: input.memberId,
      planId: plan.id,
      stripeSubscriptionId: input.stripeSubscriptionId,
      checkoutSessionId: input.checkoutSessionId,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: nominalPeriodEnd(now, plan.period),
    },
  });
}

/** Tourist weekly pass: a Subscription with TOURIST_WEEK, 7 days, no Stripe subscription (spec §3). */
export async function activateTouristPass(
  input: { memberId: string; planId: string; checkoutSessionId: string },
  opts: Opts = {},
): Promise<SubscriptionWithPlan> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const replay = await db.subscription.findUnique({
    where: { checkoutSessionId: input.checkoutSessionId },
    include: { plan: { include: { tier: true } } },
  });
  if (replay) return replay;
  const plan = await db.plan.findUnique({ where: { id: input.planId }, include: { tier: true } });
  if (!plan || plan.period !== "TOURIST_WEEK") throw new BillingError(`Plan ${input.planId} is not the tourist pass`);
  const periodEnd = addDays(now, TOURIST_PASS_DAYS);
  const sub = await db.subscription.create({
    data: {
      memberId: input.memberId,
      planId: plan.id,
      checkoutSessionId: input.checkoutSessionId,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      // firstPaidAt stays null: the tourist pass never counts for referral vesting (spec §9).
    },
    include: { plan: { include: { tier: true } } },
  });
  await supersedeLocalSubscriptions(input.memberId, sub.id, { db, now });
  await grantForSubPeriod(sub, now, periodEnd, { db, now });
  return sub;
}

export async function markPastDue(stripeSubscriptionId: string, opts: Opts = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const res = await db.subscription.updateMany({
    where: { stripeSubscriptionId, status: "ACTIVE" },
    data: { status: "PAST_DUE" },
  });
  return res.count > 0;
}

/**
 * Mirror customer.subscription.updated: plan (price change), cancel flag,
 * status and period end. Keys for a new tier arrive with the next grant —
 * never here (spec §3 "applies from the next period").
 */
export async function mirrorStripeSubscription(
  input: {
    stripeSubscriptionId: string;
    stripePriceId?: string | null;
    status?: string | null;
    cancelAtPeriodEnd?: boolean | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
  },
  opts: Opts = {},
): Promise<Subscription | null> {
  const db = opts.db ?? defaultPrisma;
  const sub = await db.subscription.findUnique({ where: { stripeSubscriptionId: input.stripeSubscriptionId } });
  if (!sub) return null;
  if (input.status === "canceled") return endStripeSubscription(input.stripeSubscriptionId, opts);

  const data: Prisma.SubscriptionUpdateInput = {};
  if (input.stripePriceId) {
    const price = await db.planPrice.findUnique({ where: { stripePriceId: input.stripePriceId } });
    if (price && price.planId !== sub.planId) data.plan = { connect: { id: price.planId } };
  }
  if (typeof input.cancelAtPeriodEnd === "boolean") data.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
  if (input.status === "active" && sub.status !== "ACTIVE") data.status = "ACTIVE";
  if ((input.status === "past_due" || input.status === "unpaid") && sub.status === "ACTIVE") data.status = "PAST_DUE";
  if (input.currentPeriodEnd && input.currentPeriodEnd.getTime() !== sub.currentPeriodEnd.getTime()) {
    data.currentPeriodEnd = input.currentPeriodEnd;
    if (input.currentPeriodStart) data.currentPeriodStart = input.currentPeriodStart;
  }
  if (Object.keys(data).length === 0) return sub;
  return db.subscription.update({ where: { id: sub.id }, data });
}

/** customer.subscription.deleted: the paid membership is over; back to FREE. */
export async function endStripeSubscription(stripeSubscriptionId: string, opts: Opts = {}): Promise<Subscription | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const sub = await db.subscription.findUnique({ where: { stripeSubscriptionId } });
  if (!sub) return null;
  if (sub.status === "CANCELLED") return sub;
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELLED", nextGrantAt: null },
  });
  // The pool's expiry IS this subscription's period end, so passing it expires
  // the remainder now even when Stripe ended the subscription early (dunning).
  await expirePlanKeys(sub.memberId, sub.currentPeriodEnd, { db, now });
  await ensureFreeSubscription(sub.memberId, { db, now });
  return updated;
}

/**
 * Job (daily): monthly key grants for quarterly/yearly plans and the FREE
 * tier. For each live subscription with `nextGrantAt <= now`: expire last
 * month's remainder, grant this month, schedule the next. PAST_DUE
 * subscriptions are skipped until Stripe recovers the payment.
 */
export async function runMonthlyGrants(opts: JobOpts = {}): Promise<{ granted: number; skipped: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const due = await db.subscription.findMany({
    where: { nextGrantAt: { lte: now }, status: { in: LIVE }, ...(opts.memberId ? { memberId: opts.memberId } : {}) },
    include: { plan: { include: { tier: true } } },
    orderBy: { nextGrantAt: "asc" },
  });
  let granted = 0;
  let skipped = 0;
  for (const sub of due) {
    if (sub.status !== "ACTIVE") {
      skipped++;
      continue;
    }
    const grantStart = sub.nextGrantAt!;
    await expirePlanKeys(sub.memberId, grantStart, { db, now });

    if (!sub.stripeSubscriptionId && sub.plan.period === "MONTHLY") {
      // FREE (and any local monthly plan): the period itself rolls forward.
      const periodEnd = addMonths(grantStart, 1);
      const rolled = await db.subscription.update({
        where: { id: sub.id },
        data: { currentPeriodStart: grantStart, currentPeriodEnd: periodEnd, nextGrantAt: periodEnd },
        include: { plan: { include: { tier: true } } },
      });
      await grantForSubPeriod(rolled, grantStart, periodEnd, { db, now });
    } else {
      const { expiresAt, nextGrantAt } = monthlyGrantWindow(grantStart, sub.currentPeriodEnd);
      await db.subscription.update({ where: { id: sub.id }, data: { nextGrantAt } });
      await grantForSubPeriod(sub, grantStart, expiresAt, { db, now });
    }
    granted++;
  }
  return { granted, skipped };
}

/**
 * Job (hourly): periods that ended. Tourist passes become EXPIRED and the
 * member drops back to FREE; recurring subscriptions keep their status (Stripe
 * decides via invoice.paid / subscription.deleted) but their plan keys expire.
 */
export async function runExpirePeriods(opts: JobOpts = {}): Promise<{ expiredPasses: number; expiredKeys: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const ended = await db.subscription.findMany({
    where: { currentPeriodEnd: { lte: now }, status: { in: LIVE }, ...(opts.memberId ? { memberId: opts.memberId } : {}) },
    include: { plan: true },
  });
  let expiredPasses = 0;
  let expiredKeys = 0;
  for (const sub of ended) {
    const { expired } = await expirePlanKeys(sub.memberId, sub.currentPeriodEnd, { db, now });
    if (expired > 0) expiredKeys++;
    if (sub.plan.period === "TOURIST_WEEK") {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "EXPIRED", nextGrantAt: null } });
      await ensureFreeSubscription(sub.memberId, { db, now });
      expiredPasses++;
    }
  }
  return { expiredPasses, expiredKeys };
}
