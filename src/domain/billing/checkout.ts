import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { BillingError } from "./errors";
import { isRecurring } from "./periods";
import { billingStripe } from "./stripe-client";
import { getMembership } from "./subscriptions";

/**
 * Stripe Checkout (ported from EventOS's redirect flow): every purchase opens
 * a hosted session and NOTHING is fulfilled on the redirect back — only the
 * signed webhook (./webhooks.ts) grants keys or activates plans. The session
 * metadata `kind` tells the webhook what it is looking at.
 */

export interface CheckoutUrls {
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutOpts {
  db?: PrismaClient;
}

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function defaultCheckoutUrls(cancelPath = "/app/membership"): CheckoutUrls {
  return {
    successUrl: `${appUrl()}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl()}${cancelPath}`,
  };
}

/** Stripe Customer per member, created on first purchase and reused for life. */
export async function ensureStripeCustomer(memberId: string, opts: CheckoutOpts = {}): Promise<string> {
  const db = opts.db ?? defaultPrisma;
  const existing = await db.stripeCustomer.findUnique({ where: { memberId } });
  if (existing) return existing.stripeCustomerId;
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
  const customer = await billingStripe().customers.create(
    { email: member.email, name: member.name ?? undefined, metadata: { memberId } },
    { idempotencyKey: `customer_${memberId}` },
  );
  await db.stripeCustomer.upsert({
    where: { memberId },
    update: { stripeCustomerId: customer.id },
    create: { memberId, stripeCustomerId: customer.id },
  });
  return customer.id;
}

async function loadPrice(db: PrismaClient, planPriceId: string) {
  const price = await db.planPrice.findUnique({
    where: { id: planPriceId },
    include: { plan: { include: { tier: true } }, city: true },
  });
  if (!price || !price.plan.isActive) throw new BillingError("That plan is not available");
  if (!price.stripePriceId) throw new BillingError("That plan is not synced to Stripe yet (run pnpm stripe:sync-prices)");
  return price;
}

async function assertCity(db: PrismaClient, memberId: string, cityId: string) {
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
  if (member.cityId && member.cityId !== cityId) throw new BillingError("That price is for another city");
  return member;
}

/** Subscription checkout for any recurring Plan/PlanPrice. */
export async function startSubscriptionCheckout(
  memberId: string,
  planPriceId: string,
  urls: CheckoutUrls = defaultCheckoutUrls(),
  opts: CheckoutOpts = {},
): Promise<{ url: string; sessionId: string }> {
  const db = opts.db ?? defaultPrisma;
  const price = await loadPrice(db, planPriceId);
  if (!isRecurring(price.plan.period)) throw new BillingError("Use the tourist pass checkout for the weekly pass");
  if (price.amountCents <= 0) throw new BillingError("The free tier needs no checkout");
  await assertCity(db, memberId, price.cityId);
  const membership = await getMembership(memberId, { db });
  if (membership.isRecurring) {
    throw new BillingError("You already have a subscription — change your plan instead of starting a new one");
  }
  const customer = await ensureStripeCustomer(memberId, { db });
  const session = await billingStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: price.stripePriceId!, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    metadata: { kind: "subscription", memberId, planId: price.planId, planPriceId: price.id },
    // Mirrored on the Subscription so renewal invoices trace back to the member.
    subscription_data: { metadata: { memberId, planId: price.planId } },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  if (!session.url) throw new BillingError("Stripe did not return a Checkout URL");
  return { url: session.url, sessionId: session.id };
}

/** Key pack one-off checkout. FREE members cannot buy packs (spec §3). */
export async function startKeyPackCheckout(
  memberId: string,
  keyPackId: string,
  urls: CheckoutUrls = defaultCheckoutUrls("/app/wallet"),
  opts: CheckoutOpts = {},
): Promise<{ url: string; sessionId: string }> {
  const db = opts.db ?? defaultPrisma;
  const pack = await db.keyPack.findUnique({ where: { id: keyPackId } });
  if (!pack || !pack.isActive) throw new BillingError("That key pack is not available");
  if (!pack.stripePriceId) throw new BillingError("That key pack is not synced to Stripe yet (run pnpm stripe:sync-prices)");
  const membership = await getMembership(memberId, { db });
  if (!membership.canBuyPacks) {
    throw new BillingError("Key packs are for paid members. Pick a plan first — it's cheaper per key anyway.");
  }
  const customer = await ensureStripeCustomer(memberId, { db });
  const session = await billingStripe().checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    metadata: { kind: "key_pack", memberId, keyPackId: pack.id },
    payment_intent_data: { metadata: { kind: "key_pack", memberId, keyPackId: pack.id } },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  if (!session.url) throw new BillingError("Stripe did not return a Checkout URL");
  return { url: session.url, sessionId: session.id };
}

/** Tourist weekly pass one-off checkout (7 days, no renewal). */
export async function startTouristPassCheckout(
  memberId: string,
  urls: CheckoutUrls = defaultCheckoutUrls(),
  opts: CheckoutOpts = {},
): Promise<{ url: string; sessionId: string }> {
  const db = opts.db ?? defaultPrisma;
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
  if (!member.cityId) throw new BillingError("Choose your city before buying a pass");
  const price = await db.planPrice.findFirst({
    where: { cityId: member.cityId, plan: { period: "TOURIST_WEEK", isActive: true } },
    include: { plan: { include: { tier: true } } },
  });
  if (!price) throw new BillingError("The tourist pass is not available in your city");
  if (!price.stripePriceId) throw new BillingError("The tourist pass is not synced to Stripe yet (run pnpm stripe:sync-prices)");
  const membership = await getMembership(memberId, { db });
  if (membership.isPaid) throw new BillingError("You already have an active membership");
  // TODO Phase 3: require member.idPhotoUploadedAt (spec §3 "ID photo required at purchase").
  const customer = await ensureStripeCustomer(memberId, { db });
  const session = await billingStripe().checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [{ price: price.stripePriceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    metadata: { kind: "tourist_pass", memberId, planId: price.planId, planPriceId: price.id },
    payment_intent_data: { metadata: { kind: "tourist_pass", memberId, planId: price.planId } },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  if (!session.url) throw new BillingError("Stripe did not return a Checkout URL");
  return { url: session.url, sessionId: session.id };
}

/**
 * Upgrade/downgrade: swap the Stripe price with proration. The plan change is
 * mirrored by customer.subscription.updated; keys for the new tier apply from
 * the next grant (spec §3) — nothing is granted here.
 */
export async function changeSubscriptionPlan(memberId: string, planPriceId: string, opts: CheckoutOpts = {}): Promise<void> {
  const db = opts.db ?? defaultPrisma;
  const membership = await getMembership(memberId, { db });
  const sub = membership.subscription;
  if (!membership.isRecurring || !sub?.stripeSubscriptionId) {
    throw new BillingError("No subscription to change — pick a plan to subscribe first");
  }
  const price = await loadPrice(db, planPriceId);
  if (!isRecurring(price.plan.period) || price.amountCents <= 0) throw new BillingError("Pick a paid recurring plan");
  await assertCity(db, memberId, price.cityId);
  if (price.planId === sub.planId) throw new BillingError("You're already on that plan");
  const stripe = billingStripe();
  const remote = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const item = remote.items.data[0];
  if (!item) throw new BillingError("Stripe subscription has no items");
  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: item.id, price: price.stripePriceId! }],
    proration_behavior: "create_prorations",
    cancel_at_period_end: false,
  });
  // Optimistic mirror so the UI reflects it before the webhook lands; the webhook is still the truth.
  await db.subscription.update({ where: { id: sub.id }, data: { planId: price.planId, cancelAtPeriodEnd: false } });
}

/** Cancel = cancelAtPeriodEnd (spec: stays active until the paid period ends). */
export async function setCancelAtPeriodEnd(memberId: string, cancel: boolean, opts: CheckoutOpts = {}): Promise<void> {
  const db = opts.db ?? defaultPrisma;
  const membership = await getMembership(memberId, { db });
  const sub = membership.subscription;
  if (!membership.isRecurring || !sub?.stripeSubscriptionId) throw new BillingError("No subscription to cancel");
  await billingStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: cancel });
  await db.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: cancel } });
}

/** Stripe Billing customer portal (payment method, invoices). */
export async function createPortalSession(memberId: string, returnUrl = `${appUrl()}/app/membership`, opts: CheckoutOpts = {}): Promise<string> {
  const customer = await ensureStripeCustomer(memberId, opts);
  const session = await billingStripe().billingPortal.sessions.create({ customer, return_url: returnUrl });
  return session.url;
}
