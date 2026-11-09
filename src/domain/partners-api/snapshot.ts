import type { AllocationType, Offer, Prisma, PrismaClient, RedemptionStatus, TierCode } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "@/lib/db";
import { windowUntilFromLocalTime } from "@/lib/time";
import { generatePin, generateScannerCode, hashPin } from "@/domain/events/events";
import { PartnerApiError, validationFailed, type ValidationDetail } from "./errors";
import { MODE_TO_TYPE, computeKeyCost, loadLimits, loadPricing, memberPriceCents, type Limits, type OfferMode, type Pricing } from "./pricing";
import { offerCountersByStatus, toOfferResult, type OfferResult } from "./sales";

/**
 * EventSnapshot / OfferSpec (contract §2.2, §2.3) and `applySnapshot` (§3.3):
 * ONE transaction that upserts the EventOS-managed event + its offers, with
 * the version guard, the frozen-fields rule, the deletion rule and the key
 * cost from the pricing rule. A 422 applies nothing.
 */
const COUNTING: RedemptionStatus[] = ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"];
const HOUR = 3_600_000;
const DEFAULT_DURATION_HOURS = 6;

const isoDate = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const nullableIsoDate = isoDate.nullable().optional();

export const OFFER_MODES = ["FULL", "DISCOUNT", "GUESTLIST"] as const;
const PAID_TIERS: TierCode[] = ["SOCIAL", "REGULAR", "PLUS"];

export const OfferSpecSchema = z.object({
  ref: z.string().trim().min(3).max(200),
  ticketType: z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    priceCents: z.number().int().min(0).max(10_000_000),
    capacity: z.number().int().min(0).nullable().optional(),
    isHidden: z.boolean().optional(),
  }),
  mode: z.enum(OFFER_MODES),
  discountPercent: z.number().int().min(0).max(100).nullable().optional(),
  capacity: z.number().int().min(1).nullable().optional(),
  plusOne: z.object({ allowed: z.boolean(), extraCashCents: z.number().int().min(0).nullable().optional() }).nullable().optional(),
  openToFree: z.boolean().optional().default(false),
  privateSale: z
    .object({ tiers: z.array(z.enum(["SOCIAL", "REGULAR", "PLUS"])).min(1), hoursBefore: z.union([z.literal(24), z.literal(48)]) })
    .nullable()
    .optional(),
  maxPerMember: z.number().int().min(1).max(100).optional().default(1),
  redeemFrom: nullableIsoDate,
  redeemUntil: nullableIsoDate,
  window: z
    .object({ untilLocalTime: z.string().regex(/^\d{2}:\d{2}$/), afterWindow: z.enum(["REFUSE", "PAY_DOOR"]) })
    .nullable()
    .optional(),
});
export type OfferSpec = z.infer<typeof OfferSpecSchema>;

export const EventSnapshotSchema = z.object({
  version: z.number().int().min(0),
  event: z.object({
    id: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(140),
    description: z.string().max(5000).nullable().optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "CANCELLED"]).optional(),
    startsAt: isoDate,
    endsAt: nullableIsoDate,
    timezone: z.string().max(64).optional(),
    venue: z.object({ name: z.string().max(140).nullable().optional(), address: z.string().max(240).nullable().optional() }).nullable().optional(),
    imageUrls: z.array(z.string().url().max(500)).max(10).optional().default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
    publicUrl: z.string().url().max(500).nullable().optional(),
  }),
  offers: z.array(OfferSpecSchema).max(50),
});
export type EventSnapshot = z.infer<typeof EventSnapshotSchema>;

export interface SnapshotResult {
  siappEventId: string;
  status: string;
  pausedAt: string | null;
  version: number;
  offers: OfferResult[];
  warnings: { ref?: string; code: string; message: string }[];
}

type Db = PrismaClient;
type Opts = { db?: Db; now?: Date };

export type ProducerForSnapshot = { id: string; cityId: string; city: { timezone: string } };

/** Zod issues → contract details (code "invalid"). */
function zodDetails(err: z.ZodError, offers: unknown): ValidationDetail[] {
  return err.issues.map((i) => {
    const path = i.path.map(String);
    let ref: string | undefined;
    if (path[0] === "offers" && typeof path[1] !== "undefined" && Array.isArray(offers)) {
      const o = offers[Number(path[1])] as { ref?: unknown } | undefined;
      if (o && typeof o.ref === "string") ref = o.ref;
    }
    return { ...(ref ? { ref } : {}), field: path.join(".") || "body", code: "invalid", message: i.message };
  });
}

interface ExistingOffer extends Offer {
  live: number; // counting statuses
  total: number; // any status
}

/** Pure semantic validation (after zod). Returns details; empty = valid. */
export function validateSnapshot(
  snap: EventSnapshot,
  ctx: { eventosEventId: string; now: Date; pricing: Pricing; limits: Limits; existing: Map<string, ExistingOffer> },
): { details: ValidationDetail[]; warnings: SnapshotResult["warnings"]; endsAt: Date } {
  const details: ValidationDetail[] = [];
  const warnings: SnapshotResult["warnings"] = [];
  const e = snap.event;
  if (e.id !== ctx.eventosEventId) details.push({ field: "event.id", code: "id_mismatch", message: "event.id must match the path" });
  let endsAt = e.endsAt ?? null;
  if (!endsAt) {
    endsAt = new Date(e.startsAt.getTime() + DEFAULT_DURATION_HOURS * HOUR);
    warnings.push({ code: "ends_at_defaulted", message: `endsAt missing — defaulted to startsAt + ${DEFAULT_DURATION_HOURS} h` });
  }
  if (endsAt <= e.startsAt) details.push({ field: "event.endsAt", code: "ends_before_starts", message: "The event must end after it starts" });
  if (endsAt <= ctx.now) details.push({ field: "event.endsAt", code: "event_in_past", message: "The event has already ended" });
  if (snap.offers.length > ctx.limits.maxOffersPerEvent) {
    details.push({ field: "offers", code: "too_many_offers", message: `At most ${ctx.limits.maxOffersPerEvent} offers per event` });
  }

  const seen = new Set<string>();
  for (const o of snap.offers) {
    const d = (field: string, code: string, message: string) => details.push({ ref: o.ref, field, code, message });
    if (seen.has(o.ref)) d("ref", "duplicate_ref", "Offer ref repeated");
    seen.add(o.ref);
    if (o.ref !== `${ctx.eventosEventId}:${o.ticketType.id}:${o.mode}`) d("ref", "ref_invalid", 'ref must be "{eventId}:{ticketTypeId}:{mode}"');

    if (o.mode === "DISCOUNT") {
      if (o.ticketType.priceCents <= 0) d("ticketType.priceCents", "face_value_required", "Discount offers need a face value > 0");
      const dp = o.discountPercent;
      if (dp === null || dp === undefined || dp < ctx.pricing.minDiscountPercent || dp > ctx.pricing.maxDiscountPercent) {
        d("discountPercent", "discount_out_of_range", `discountPercent must be between ${ctx.pricing.minDiscountPercent} and ${ctx.pricing.maxDiscountPercent}`);
      }
    }
    if (o.mode === "FULL" || o.mode === "DISCOUNT") {
      if (!o.capacity) d("capacity", "capacity_required", "Full-redemption and discount offers need a capacity");
      else {
        if (o.capacity > ctx.limits.maxCapacityPerOffer) d("capacity", "capacity_exceeds_type", `capacity above the limit of ${ctx.limits.maxCapacityPerOffer}`);
        if (o.ticketType.capacity !== null && o.ticketType.capacity !== undefined && o.capacity > o.ticketType.capacity) {
          d("capacity", "capacity_exceeds_type", `capacity exceeds the ticket type's ${o.ticketType.capacity}`);
        }
      }
    }
    if (o.mode === "GUESTLIST") {
      if (!o.window) d("window", "window_required", "Guest-list offers need a window");
      if (o.capacity) warnings.push({ ref: o.ref, code: "guestlist_capacity_ignored", message: "Guest-list offers are time-window allocations; capacity is ignored" });
    }
    if (o.privateSale && o.privateSale.tiers.some((t) => !PAID_TIERS.includes(t))) d("privateSale.tiers", "private_sale_invalid", "Private sale tiers must be paid tiers");

    const ex = ctx.existing.get(o.ref);
    if (ex) {
      if (ex.live > 0) {
        const frozen: string[] = [];
        if (ex.type !== MODE_TO_TYPE[o.mode]) frozen.push("mode");
        if (o.mode === "DISCOUNT" && (ex.discountPercent ?? null) !== (o.discountPercent ?? null)) frozen.push("discountPercent");
        if ((ex.faceValueCents ?? 0) !== o.ticketType.priceCents && o.mode !== "GUESTLIST") frozen.push("ticketType.priceCents");
        if (o.mode === "GUESTLIST" && ex.afterWindowBehaviour !== (o.window?.afterWindow ?? null)) frozen.push("window.afterWindow");
        if (frozen.length > 0) d(frozen[0]!, "offer_frozen", `${frozen.join(", ")} can't change after members redeemed`);
        if (o.capacity && ex.capacity !== null && o.capacity < ex.live) d("capacity", "capacity_below_redeemed", `capacity can't go below the ${ex.live} already redeemed`);
      }
    }
  }
  for (const [ref, ex] of ctx.existing) {
    if (!seen.has(ref) && ex.total > 0) details.push({ ref, field: "offers", code: "offer_has_redemptions", message: "This offer has redemptions and can't be removed — keep it (capacity may grow) or pause the event" });
  }
  return { details, warnings, endsAt };
}

function offerName(o: OfferSpec): string {
  if (o.mode === "DISCOUNT") return `${o.ticketType.name} · ${o.discountPercent}% off`;
  if (o.mode === "GUESTLIST") return `${o.ticketType.name} · guest list`;
  return o.ticketType.name;
}

/** Upsert the EventOS event + offers in one transaction (contract §3.3). */
export async function applySnapshot(producer: ProducerForSnapshot, eventosEventId: string, raw: unknown, opts: Opts = {}): Promise<SnapshotResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = EventSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(zodDetails(parsed.error, (raw as { offers?: unknown } | null)?.offers));
  const snap = parsed.data;
  const tz = producer.city.timezone;

  return db.$transaction(async (tx) => {
    const [pricing, limits] = [await loadPricing(tx), await loadLimits(tx)];
    const existingEvent = await tx.event.findUnique({ where: { producerId_externalId: { producerId: producer.id, externalId: eventosEventId } }, include: { offers: true } });
    if (existingEvent && existingEvent.source !== "EVENTOS") throw new PartnerApiError(409, "conflict", "This event is managed by SIAPP staff");
    if (existingEvent && snap.version < existingEvent.snapshotVersion) {
      throw new PartnerApiError(409, "stale_version", `Snapshot version ${snap.version} is older than the stored ${existingEvent.snapshotVersion}`);
    }
    if (existingEvent && (existingEvent.status === "FINISHED" || existingEvent.status === "CANCELLED")) {
      throw new PartnerApiError(409, "conflict", `The event is ${existingEvent.status.toLowerCase()} on SIAPP and can't be changed`);
    }

    const existing = new Map<string, ExistingOffer>();
    if (existingEvent) {
      const ids = existingEvent.offers.map((o) => o.id);
      const counts = ids.length ? await tx.redemption.groupBy({ by: ["offerId", "status"], where: { offerId: { in: ids } }, _count: { _all: true } }) : [];
      for (const o of existingEvent.offers) {
        if (!o.externalRef) continue;
        const mine = counts.filter((c) => c.offerId === o.id);
        existing.set(o.externalRef, {
          ...o,
          live: mine.filter((c) => COUNTING.includes(c.status)).reduce((n, c) => n + c._count._all, 0),
          total: mine.reduce((n, c) => n + c._count._all, 0),
        });
      }
    }

    const { details, warnings, endsAt } = validateSnapshot(snap, { eventosEventId, now, pricing, limits, existing });
    if (snap.event.timezone && snap.event.timezone !== tz) warnings.push({ code: "timezone_mismatch", message: `EventOS timezone ${snap.event.timezone} differs from the city's ${tz}; wall-clock windows use ${tz}` });
    if (details.length > 0) throw validationFailed(details);

    const eventData = {
      title: snap.event.title,
      description: snap.event.description ?? null,
      venue: snap.event.venue?.name ?? null,
      address: snap.event.venue?.address ?? null,
      imageUrls: snap.event.imageUrls,
      tags: [...new Set(snap.event.tags.map((t) => t.toLowerCase()))],
      startsAt: snap.event.startsAt,
      endsAt,
      snapshotVersion: snap.version,
    };
    const event = existingEvent
      ? await tx.event.update({ where: { id: existingEvent.id }, data: eventData })
      : await tx.event.create({
          data: {
            ...eventData,
            producerId: producer.id,
            cityId: producer.cityId,
            status: "DRAFT",
            source: "EVENTOS",
            externalId: eventosEventId,
            scannerCode: generateScannerCode(),
            scannerPinHash: hashPin(generatePin()), // PIN discarded: the EventOS scanner is the door; staff can regenerate
          },
        });

    // Offers missing from the snapshot and without history are deleted.
    for (const [ref, ex] of existing) {
      if (!snap.offers.some((o) => o.ref === ref) && ex.total === 0) {
        await tx.waitlistEntry.deleteMany({ where: { offerId: ex.id } });
        await tx.offer.delete({ where: { id: ex.id } });
      }
    }

    const offerRows: Offer[] = [];
    for (const [i, o] of snap.offers.entries()) {
      const ex = existing.get(o.ref);
      const type = MODE_TO_TYPE[o.mode];
      const allocationType: AllocationType = o.mode === "GUESTLIST" ? "TIME_WINDOW" : "CAPPED";
      const computed = computeKeyCost({ mode: o.mode, priceCents: o.ticketType.priceCents, discountPercent: o.discountPercent, override: ex?.keyCostOverride }, pricing);
      // Live offers keep their key cost (like Stripe prices); a staff override always wins.
      const keyCost = ex?.keyCostOverride != null ? ex.keyCostOverride : ex && ex.live > 0 ? ex.keyCost : computed;
      const privateSale = o.privateSale ?? null;
      const data = {
        name: offerName(o),
        type,
        keyCost,
        faceValueCents: o.mode === "GUESTLIST" ? null : o.ticketType.priceCents,
        discountPercent: o.mode === "DISCOUNT" ? (o.discountPercent ?? null) : null,
        allocationType,
        capacity: allocationType === "CAPPED" ? (o.capacity ?? null) : null,
        validUntil: o.mode === "GUESTLIST" && o.window ? windowUntilFromLocalTime(snap.event.startsAt, o.window.untilLocalTime, tz) : null,
        afterWindowBehaviour: o.mode === "GUESTLIST" ? (o.window?.afterWindow ?? null) : null,
        privateSaleTiers: privateSale ? (privateSale.tiers as TierCode[]) : [],
        privateSaleHoursBefore: privateSale ? privateSale.hoursBefore : null,
        privateSaleOpensAt: privateSale
          ? ex?.privateSaleOpensAt ?? (event.publishedAt ? new Date(event.publishedAt.getTime() + privateSale.hoursBefore * HOUR) : null)
          : null,
        openToFree: o.openToFree,
        plusOneAllowed: o.plusOne?.allowed ?? false,
        // The +1 receives the same value as the member → the same key cost (pricing rule applied twice).
        plusOneExtraKeyCost: o.plusOne?.allowed ? keyCost : 0,
        plusOneExtraCashCents: o.plusOne?.allowed && o.mode === "DISCOUNT" ? (o.plusOne.extraCashCents ?? null) : null,
        maxPerMember: o.maxPerMember,
        redeemFrom: o.redeemFrom ?? null,
        redeemUntil: o.redeemUntil ?? null,
        sortOrder: i,
        paymentMode: "PRODUCER_COLLECTS" as const,
      };
      const row = ex
        ? await tx.offer.update({ where: { id: ex.id }, data })
        : await tx.offer.create({ data: { ...data, eventId: event.id, externalRef: o.ref } });
      offerRows.push(row);
    }

    const counters = await offerCountersByStatus(tx, offerRows.map((r) => r.id));
    return {
      siappEventId: event.id,
      status: event.status,
      pausedAt: event.pausedAt?.toISOString() ?? null,
      version: event.snapshotVersion,
      offers: offerRows.map((r) => toOfferResult(r, counters.get(r.id)!, r.id ? existing.get(r.externalRef!)?.live ?? 0 : 0)),
      warnings,
    };
  });
}

export type { OfferMode };
