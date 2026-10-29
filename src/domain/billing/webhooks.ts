import { prisma } from "@/lib/db";
import { registerStripeHandler, type StripeWebhookEvent } from "@/lib/stripe-webhook";
import { grantPurchasedKeys } from "@/domain/keys";
import {
  activateTouristPass,
  applyPaidPeriod,
  endStripeSubscription,
  linkStripeSubscription,
  markPastDue,
  mirrorStripeSubscription,
} from "./subscriptions";

/**
 * Stripe → SIAPP (ported from EventOS's webhook fulfilment, adapted to keys).
 * Replays are already stopped by StripeEvent (src/lib/stripe-webhook.ts);
 * every write here is additionally idempotent on its own key (grant
 * reference, checkoutSessionId, status guards) because Stripe may deliver
 * related events in any order and a handler may be retried after a crash.
 *
 * Shapes are read tolerantly across Stripe API versions: subscription id on
 * `invoice.subscription` (classic) or `invoice.parent.subscription_details`
 * (2025+); price id on `line.price.id` or `line.pricing.price_details.price`;
 * period on subscription items (2025+) or the subscription (classic).
 */

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const refId = (v: unknown): string | null => (typeof v === "string" ? v : str((v as Obj | null)?.id));
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const epochToDate = (v: unknown): Date | null => (typeof v === "number" ? new Date(v * 1000) : null);

export function invoiceSubscriptionId(invoice: Obj): string | null {
  return refId(invoice.subscription) ?? refId(obj(obj(invoice.parent)?.subscription_details)?.subscription);
}

export function invoiceMetadata(invoice: Obj): Record<string, string> {
  const meta =
    obj(obj(obj(invoice.parent)?.subscription_details)?.metadata) ??
    obj(obj(invoice.subscription_details)?.metadata) ??
    {};
  return meta as Record<string, string>;
}

export interface InvoiceLine {
  priceId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export function invoiceLines(invoice: Obj): InvoiceLine[] {
  const lines = (obj(invoice.lines)?.data as unknown[] | undefined) ?? [];
  return lines.map((raw) => {
    const line = obj(raw) ?? {};
    const period = obj(line.period);
    return {
      priceId: refId(obj(line.price)?.id) ?? str(obj(obj(line.pricing)?.price_details)?.price),
      periodStart: epochToDate(period?.start),
      periodEnd: epochToDate(period?.end),
    };
  });
}

export function subscriptionPeriod(sub: Obj): { priceId: string | null; start: Date | null; end: Date | null } {
  const item = obj((obj(sub.items)?.data as unknown[] | undefined)?.[0]);
  return {
    priceId: refId(obj(item?.price)?.id) ?? null,
    start: epochToDate(item?.current_period_start) ?? epochToDate(sub.current_period_start),
    end: epochToDate(item?.current_period_end) ?? epochToDate(sub.current_period_end),
  };
}

async function memberIdForCustomer(customer: unknown): Promise<string | null> {
  const id = refId(customer);
  if (!id) return null;
  const row = await prisma.stripeCustomer.findUnique({ where: { stripeCustomerId: id } });
  return row?.memberId ?? null;
}

async function handleCheckoutCompleted(event: StripeWebhookEvent): Promise<string | null> {
  const session = event.data.object as Obj;
  const meta = (obj(session.metadata) ?? {}) as Record<string, string>;
  const kind = meta.kind;
  const memberId = meta.memberId ?? (await memberIdForCustomer(session.customer));
  if (!kind || !memberId) return `ignored session ${session.id}: no SIAPP metadata`;
  if (kind === "redemption") return null; // owned by src/domain/redemption/webhooks.ts

  if (kind === "subscription") {
    const stripeSubscriptionId = refId(session.subscription);
    if (!stripeSubscriptionId || !meta.planId) return `subscription session ${session.id} without subscription/plan`;
    await linkStripeSubscription({ memberId, stripeSubscriptionId, planId: meta.planId, checkoutSessionId: String(session.id) });
    return `linked subscription ${stripeSubscriptionId} to member ${memberId}`;
  }

  // One-off purchases: wait for the money (async methods complete later).
  if (session.payment_status && session.payment_status !== "paid") {
    return `session ${session.id} completed but ${session.payment_status} — awaiting async confirmation`;
  }
  if (kind === "key_pack") {
    const pack = await prisma.keyPack.findUnique({ where: { id: meta.keyPackId ?? "" } });
    if (!pack) return `key pack ${meta.keyPackId} not found`;
    await grantPurchasedKeys(memberId, pack.keys, "PACK_PURCHASE", {
      reference: `pack:${session.id}`,
      note: pack.name,
    });
    return `granted ${pack.keys} purchased keys to member ${memberId}`;
  }
  if (kind === "tourist_pass") {
    if (!meta.planId) return `tourist session ${session.id} without plan`;
    const sub = await activateTouristPass({ memberId, planId: meta.planId, checkoutSessionId: String(session.id) });
    return `tourist pass ${sub.id} active until ${sub.currentPeriodEnd.toISOString()}`;
  }
  return `ignored session kind ${kind}`;
}

async function handleInvoicePaid(event: StripeWebhookEvent): Promise<string> {
  const invoice = event.data.object as Obj;
  const reason = str(invoice.billing_reason);
  if (reason !== "subscription_create" && reason !== "subscription_cycle") {
    return `ignored invoice.paid billing_reason=${reason ?? "unknown"} (plan changes grant from the next period)`;
  }
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) return `invoice ${invoice.id} has no subscription`;
  const line = invoiceLines(invoice).find((l) => l.periodStart && l.periodEnd);
  if (!line?.periodStart || !line.periodEnd) return `invoice ${invoice.id} has no period line`;

  const meta = invoiceMetadata(invoice);
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
  const memberId = existing?.memberId ?? meta.memberId ?? (await memberIdForCustomer(invoice.customer));
  if (!memberId) return `invoice ${invoice.id}: cannot resolve member`;

  const price = line.priceId ? await prisma.planPrice.findUnique({ where: { stripePriceId: line.priceId } }) : null;
  const planId = price?.planId ?? meta.planId ?? existing?.planId;
  if (!planId) return `invoice ${invoice.id}: cannot resolve plan for price ${line.priceId}`;

  const sub = await applyPaidPeriod({
    memberId,
    stripeSubscriptionId,
    planId,
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
    invoiceId: str(invoice.id) ?? undefined,
  });
  return `${reason}: period ${sub.currentPeriodStart.toISOString()} → ${sub.currentPeriodEnd.toISOString()} applied to subscription ${sub.id}`;
}

async function handleInvoiceFailed(event: StripeWebhookEvent): Promise<string> {
  const invoice = event.data.object as Obj;
  if (str(invoice.billing_reason) !== "subscription_cycle") return "ignored (not a renewal)";
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) return "no subscription";
  const changed = await markPastDue(stripeSubscriptionId, { invoiceId: str(invoice.id) ?? undefined });
  return changed ? `subscription ${stripeSubscriptionId} PAST_DUE` : "no change";
}

async function handleSubscriptionUpdated(event: StripeWebhookEvent): Promise<string> {
  const sub = event.data.object as Obj;
  const period = subscriptionPeriod(sub);
  const row = await mirrorStripeSubscription({
    stripeSubscriptionId: String(sub.id),
    stripePriceId: period.priceId,
    status: str(sub.status),
    cancelAtPeriodEnd: typeof sub.cancel_at_period_end === "boolean" ? sub.cancel_at_period_end : null,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  });
  return row ? `mirrored subscription ${sub.id} (${row.status}, cancelAtPeriodEnd=${row.cancelAtPeriodEnd})` : `unknown subscription ${sub.id}`;
}

async function handleSubscriptionDeleted(event: StripeWebhookEvent): Promise<string> {
  const sub = event.data.object as Obj;
  const row = await endStripeSubscription(String(sub.id));
  return row ? `subscription ${sub.id} ended → member back on FREE` : `unknown subscription ${sub.id}`;
}

let registered = false;

/** Idempotent: call from the webhook route module and from tests. */
export function registerBillingWebhooks(): void {
  if (registered) return;
  registered = true;
  registerStripeHandler("checkout.session.completed", handleCheckoutCompleted);
  registerStripeHandler("checkout.session.async_payment_succeeded", handleCheckoutCompleted);
  registerStripeHandler("invoice.paid", handleInvoicePaid);
  registerStripeHandler("invoice.payment_failed", handleInvoiceFailed);
  registerStripeHandler("customer.subscription.updated", handleSubscriptionUpdated);
  registerStripeHandler("customer.subscription.deleted", handleSubscriptionDeleted);
}
