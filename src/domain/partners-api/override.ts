import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { EventError } from "@/domain/events/events";
import { TYPE_TO_MODE, computeKeyCost, loadPricing } from "./pricing";

/**
 * Staff override of an EventOS offer's key cost (owner decision D: producers
 * never set key costs; SIAPP staff may, per offer). `null` clears the override
 * and recomputes from the pricing rule. Existing redemptions keep what they paid.
 */
export async function setOfferKeyCostOverride(offerId: string, override: number | null, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const offer = await db.offer.findUnique({ where: { id: offerId }, include: { event: true } });
  if (!offer) throw new EventError("Offer not found");
  if (offer.event.source !== "EVENTOS") throw new EventError("Only EventOS offers use the pricing rule — edit the key cost directly");
  if (override !== null && (!Number.isInteger(override) || override < 0 || override > 100_000)) throw new EventError("Key cost must be a whole number");
  const pricing = await loadPricing(db);
  const keyCost = computeKeyCost({ mode: TYPE_TO_MODE[offer.type], priceCents: offer.faceValueCents ?? 0, discountPercent: offer.discountPercent, override }, pricing);
  return db.offer.update({ where: { id: offerId }, data: { keyCostOverride: override, keyCost, plusOneExtraKeyCost: offer.plusOneAllowed ? keyCost : 0 } });
}
