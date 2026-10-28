import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { registerStripeHandler, type StripeWebhookEvent } from "@/lib/stripe-webhook";

/**
 * SAME_CARD evidence: Stripe's card fingerprint is stable per card across
 * customers. Captured from `charge.succeeded` (fires for Checkout payments
 * and subscription invoices alike) and mapped to the member through
 * StripeCustomer.
 */
export async function recordCardFingerprint(
  memberId: string,
  card: { fingerprint: string; brand?: string | null; last4?: string | null },
  opts: { db?: PrismaClient; now?: Date } = {},
) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  return db.paymentMethodFingerprint.upsert({
    where: { memberId_fingerprint: { memberId, fingerprint: card.fingerprint } },
    update: { lastSeenAt: now, brand: card.brand ?? undefined, last4: card.last4 ?? undefined },
    create: { memberId, fingerprint: card.fingerprint, brand: card.brand ?? null, last4: card.last4 ?? null, firstSeenAt: now, lastSeenAt: now },
  });
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function handleChargeSucceeded(event: StripeWebhookEvent): Promise<string> {
  const charge = event.data.object as Obj;
  const card = obj(obj(charge.payment_method_details)?.card);
  const fingerprint = str(card?.fingerprint);
  if (!fingerprint) return "charge without a card fingerprint";
  const customerId = str(charge.customer) ?? str(obj(charge.customer)?.id);
  let memberId = str(obj(charge.metadata)?.memberId);
  if (!memberId && customerId) {
    const row = await defaultPrisma.stripeCustomer.findUnique({ where: { stripeCustomerId: customerId } });
    memberId = row?.memberId ?? null;
  }
  if (!memberId) return `charge ${charge.id}: no member for customer ${customerId ?? "?"}`;
  await recordCardFingerprint(memberId, { fingerprint, brand: str(card?.brand), last4: str(card?.last4) });
  return `card fingerprint recorded for member ${memberId}`;
}

let registered = false;
export function registerFraudWebhooks(): void {
  if (registered) return;
  registered = true;
  registerStripeHandler("charge.succeeded", handleChargeSucceeded);
}
