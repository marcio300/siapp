import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { localToUtc, utcToLocal, windowUntilFromLocalTime } from "@/lib/time";
import { EventError } from "./events";
import { OfferSchema, type OfferInput } from "./schemas";

/**
 * Offers (spec §6) nested under an event. Time-window "until" is entered as
 * a local time (02:00) and stored as the absolute UTC instant of the next
 * 02:00 after the event starts; private-sale opens-at = publishedAt + 24/48 h
 * (computed on publish unless set explicitly here).
 */
type Opts = { db?: PrismaClient; now?: Date };

async function buildOfferData(db: PrismaClient, eventId: string, raw: OfferInput) {
  const parsed = OfferSchema.safeParse(raw);
  if (!parsed.success) throw new EventError(parsed.error.issues[0]?.message ?? "Invalid offer");
  const o = parsed.data;
  const event = await db.event.findUnique({ where: { id: eventId }, include: { city: true } });
  if (!event) throw new EventError("Event not found");
  const tz = event.city.timezone;
  const isDiscount = o.type === "DISCOUNT_TICKET";
  const isWindow = o.allocationType === "TIME_WINDOW";
  const privateSale = o.privateSaleTiers.length > 0;
  const explicitOpensAt = privateSale && o.privateSaleOpensAt ? localToUtc(o.privateSaleOpensAt, tz) : null;
  const computedOpensAt =
    privateSale && !explicitOpensAt && event.publishedAt && o.privateSaleHoursBefore
      ? new Date(event.publishedAt.getTime() + o.privateSaleHoursBefore * 3_600_000)
      : null;
  return {
    event,
    data: {
      name: o.name,
      type: o.type,
      keyCost: o.keyCost,
      faceValueCents: isDiscount ? Math.round((o.faceValueEuros ?? 0) * 100) : null,
      discountPercent: isDiscount ? (o.discountPercent ?? 0) : null,
      allocationType: o.allocationType,
      capacity: o.allocationType === "CAPPED" ? (o.capacity ?? null) : null,
      validUntil: isWindow && o.validUntilLocal ? windowUntilFromLocalTime(event.startsAt, o.validUntilLocal, tz) : null,
      afterWindowBehaviour: isWindow ? (o.afterWindowBehaviour ?? null) : null,
      privateSaleTiers: o.privateSaleTiers,
      privateSaleHoursBefore: privateSale ? (o.privateSaleHoursBefore ?? null) : null,
      privateSaleOpensAt: explicitOpensAt ?? computedOpensAt,
      openToFree: o.openToFree,
      plusOneAllowed: o.plusOneAllowed,
      plusOneExtraKeyCost: o.plusOneAllowed ? (o.plusOneExtraKeyCost ?? 0) : 0,
      plusOneExtraCashCents: o.plusOneAllowed && o.plusOneExtraCashEuros ? Math.round(o.plusOneExtraCashEuros * 100) : null,
      cancellationWindowHours: o.cancellationWindowHours ?? null,
      maxPerMember: o.maxPerMember ?? 1,
      redeemFrom: o.redeemFrom ? localToUtc(o.redeemFrom, tz) : null,
      redeemUntil: o.redeemUntil ? localToUtc(o.redeemUntil, tz) : null,
      sortOrder: o.sortOrder ?? 0,
    },
  };
}

export async function addOffer(eventId: string, raw: OfferInput, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const { event, data } = await buildOfferData(db, eventId, raw);
  if (event.status === "FINISHED" || event.status === "CANCELLED") throw new EventError(`A ${event.status.toLowerCase()} event can't take new offers`);
  return db.offer.create({ data: { ...data, eventId } });
}

export async function updateOffer(offerId: string, raw: OfferInput, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const existing = await db.offer.findUnique({ where: { id: offerId }, include: { event: true } });
  if (!existing) throw new EventError("Offer not found");
  if (existing.event.status === "FINISHED" || existing.event.status === "CANCELLED") throw new EventError("This event is closed");
  const { data } = await buildOfferData(db, existing.eventId, raw);
  const redeemed = await db.redemption.count({ where: { offerId, status: { in: ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"] } } });
  if (redeemed > 0) {
    // Economic fields are frozen once members have redeemed; capacity may only grow.
    if (data.type !== existing.type || data.keyCost !== existing.keyCost || data.faceValueCents !== existing.faceValueCents || data.discountPercent !== existing.discountPercent) {
      throw new EventError("Type, key cost and price can't change after members redeemed — add a new offer instead");
    }
    if (data.capacity !== null && existing.capacity !== null && data.capacity < existing.capacity && data.capacity < redeemed) {
      throw new EventError(`Capacity can't go below the ${redeemed} already redeemed`);
    }
  }
  return db.offer.update({ where: { id: offerId }, data });
}

export async function deleteOffer(offerId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const redemptions = await db.redemption.count({ where: { offerId } });
  if (redemptions > 0) throw new EventError("This offer has redemptions and can't be deleted");
  await db.waitlistEntry.deleteMany({ where: { offerId } });
  return db.offer.delete({ where: { id: offerId } });
}

/** Form defaults from a stored offer (UTC → wall clock, cents → euros). */
export function offerFormDefaults(offer: {
  faceValueCents: number | null;
  plusOneExtraCashCents: number | null;
  validUntil: Date | null;
  privateSaleOpensAt: Date | null;
  redeemFrom: Date | null;
  redeemUntil: Date | null;
}, timezone: string) {
  return {
    faceValueEuros: offer.faceValueCents !== null ? (offer.faceValueCents / 100).toFixed(2) : "",
    plusOneExtraCashEuros: offer.plusOneExtraCashCents !== null ? (offer.plusOneExtraCashCents / 100).toFixed(2) : "",
    validUntilLocal: offer.validUntil ? utcToLocal(offer.validUntil, timezone).time : "",
    privateSaleOpensAt: offer.privateSaleOpensAt ? utcToLocal(offer.privateSaleOpensAt, timezone) : { date: "", time: "" },
    redeemFrom: offer.redeemFrom ? utcToLocal(offer.redeemFrom, timezone) : { date: "", time: "" },
    redeemUntil: offer.redeemUntil ? utcToLocal(offer.redeemUntil, timezone) : { date: "", time: "" },
  };
}
