import type { OfferType, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";

/**
 * The pricing rule (contract §2.1) — the ONLY place an EventOS offer's key cost
 * is computed. Owner decision D (2026-11-08): €1 per key, floor 2, guest list
 * 10, no producer override; SIAPP staff may override a single offer.
 *
 *   value   = priceCents                               FULL
 *           = round(priceCents × discount / 100)        DISCOUNT
 *   keyCost = max(minKeyCost, ceil(value / keyValueCents))
 *           = guestlistKeyCost                          GUESTLIST
 */
export const CONTRACT_VERSION = "2026-11-08";
export const MAX_CAPACITY_PER_OFFER = 5000;

export type OfferMode = "FULL" | "DISCOUNT" | "GUESTLIST";

export interface Pricing {
  keyValueCents: number;
  minKeyCost: number;
  guestlistKeyCost: number;
  keyCostOverridePct: number;
  minDiscountPercent: number;
  maxDiscountPercent: number;
}

export interface Limits {
  maxOffersPerEvent: number;
  maxCapacityPerOffer: number;
  paymentHoldMinutes: number;
  noShowGraceHours: number;
}

export const MODE_TO_TYPE: Record<OfferMode, OfferType> = { FULL: "FREE_TICKET", DISCOUNT: "DISCOUNT_TICKET", GUESTLIST: "GUESTLIST" };
export const TYPE_TO_MODE: Record<OfferType, OfferMode> = { FREE_TICKET: "FULL", DISCOUNT_TICKET: "DISCOUNT", GUESTLIST: "GUESTLIST" };

export function memberPriceCents(priceCents: number, discountPercent: number): number {
  return priceCents - Math.round((priceCents * discountPercent) / 100);
}

export function valueToMemberCents(mode: OfferMode, priceCents: number, discountPercent: number | null | undefined): number {
  if (mode === "FULL") return priceCents;
  if (mode === "DISCOUNT") return Math.round((priceCents * (discountPercent ?? 0)) / 100);
  return 0;
}

export function computeKeyCost(
  input: { mode: OfferMode; priceCents: number; discountPercent?: number | null; override?: number | null },
  pricing: Pricing,
): number {
  if (input.override !== null && input.override !== undefined) return input.override;
  if (input.mode === "GUESTLIST") return pricing.guestlistKeyCost;
  const value = valueToMemberCents(input.mode, input.priceCents, input.discountPercent);
  return Math.max(pricing.minKeyCost, Math.ceil(value / pricing.keyValueCents));
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadPricing(db: Db = defaultPrisma): Promise<Pricing> {
  const [keyValueCents, minKeyCost, guestlistKeyCost, keyCostOverridePct, minDiscountPercent, maxDiscountPercent] = await Promise.all([
    getSetting("key_value_cents", db),
    getSetting("min_key_cost", db),
    getSetting("guestlist_key_cost", db),
    getSetting("key_cost_override_pct", db),
    getSetting("min_discount_percent", db),
    getSetting("max_discount_percent", db),
  ]);
  return { keyValueCents, minKeyCost, guestlistKeyCost, keyCostOverridePct, minDiscountPercent, maxDiscountPercent };
}

export async function loadLimits(db: Db = defaultPrisma): Promise<Limits> {
  const [maxOffersPerEvent, paymentHoldMinutes, noShowGraceHours] = await Promise.all([
    getSetting("partner_max_offers_per_event", db),
    getSetting("partner_payment_hold_minutes", db),
    getSetting("eventos_noshow_grace_hours", db),
  ]);
  return { maxOffersPerEvent, maxCapacityPerOffer: MAX_CAPACITY_PER_OFFER, paymentHoldMinutes, noShowGraceHours };
}
