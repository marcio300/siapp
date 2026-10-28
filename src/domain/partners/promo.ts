import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TIER_CODES } from "@/domain/events/schemas";
import { startPromoPeriod } from "@/domain/billing";
import { grantPurchasedKeys } from "@/domain/keys";
import { billingStripe } from "@/domain/billing/stripe-client";

/**
 * What a partner community grants on a successful claim (PartnerCommunity.promo).
 *  - PLAN_PERIOD: a paid tier for N months, no Stripe (new members).
 *  - KEYS: purchased-pool keys that never expire (anyone).
 *  - STRIPE_COUPON: a coupon applied to the member's live Stripe subscription (paying members).
 */
export const PromoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PLAN_PERIOD"), tier: z.enum(TIER_CODES).refine((t) => t !== "FREE", "Pick a paid tier"), months: z.number().int().min(1).max(24) }),
  z.object({ kind: z.literal("KEYS"), keys: z.number().int().min(1).max(10_000) }),
  z.object({ kind: z.literal("STRIPE_COUPON"), couponId: z.string().trim().min(1).max(100) }),
]);
export type Promo = z.infer<typeof PromoSchema>;

export function parsePromo(json: unknown): Promo {
  const parsed = PromoSchema.safeParse(json);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid promo");
  return parsed.data;
}

export function describePromo(promo: Promo): string {
  switch (promo.kind) {
    case "PLAN_PERIOD":
      return `${promo.tier} for ${promo.months} month${promo.months === 1 ? "" : "s"}, on the house`;
    case "KEYS":
      return `${promo.keys} keys that never expire`;
    case "STRIPE_COUPON":
      return `Stripe coupon ${promo.couponId} on your subscription`;
  }
}

/** Apply the promo for a member. Runs inside the claim transaction when possible. */
export async function applyPromo(
  memberId: string,
  promo: Promo,
  ref: { claimId: string; communityCode: string },
  opts: { db: PrismaClient | Prisma.TransactionClient; now: Date },
): Promise<string> {
  switch (promo.kind) {
    case "PLAN_PERIOD": {
      await startPromoPeriod({ memberId, tierCode: promo.tier, months: promo.months, note: `${ref.communityCode} promo` }, opts);
      return describePromo(promo);
    }
    case "KEYS": {
      await grantPurchasedKeys(memberId, promo.keys, "PROMO_GRANT", { reference: `partner:${ref.claimId}`, note: `${ref.communityCode} welcome keys` }, opts);
      return describePromo(promo);
    }
    case "STRIPE_COUPON": {
      const sub = await opts.db.subscription.findFirst({ where: { memberId, status: { in: ["ACTIVE", "PAST_DUE"] }, stripeSubscriptionId: { not: null } } });
      if (!sub?.stripeSubscriptionId) throw new Error("This promo is a discount on a paid plan — subscribe first, then claim it");
      await billingStripe().subscriptions.update(sub.stripeSubscriptionId, { discounts: [{ coupon: promo.couponId }] });
      return describePromo(promo);
    }
  }
}
