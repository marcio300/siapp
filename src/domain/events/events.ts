import type { EventStatus, Prisma, PrismaClient } from "@prisma/client";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { prisma as defaultPrisma } from "@/lib/db";
import { localToUtc, utcToLocal } from "@/lib/time";
import { EventSchema, type EventInput } from "./schemas";

/**
 * Events (spec §6): a night/show by a producer, in the producer's city, with
 * 1..n offers. Status flow DRAFT → PUBLISHED ⇄ (unpublish) DRAFT; PUBLISHED →
 * CANCELLED | FINISHED. Publishing stamps `publishedAt` once and computes the
 * private-sale opens-at of offers that asked for 24/48 h (see offers.ts).
 * Scanner login = per-event code + PIN (PIN hashed, shown once).
 */
export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventError";
  }
}

type Opts = { db?: PrismaClient; now?: Date };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateScannerCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function parseEvent(db: PrismaClient, raw: EventInput) {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) throw new EventError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;
  const producer = await db.producer.findUnique({ where: { id: input.producerId }, include: { city: true } });
  if (!producer) throw new EventError("Pick a producer");
  const tz = producer.city.timezone;
  const startsAt = localToUtc(input.startsAt, tz);
  const endsAt = localToUtc(input.endsAt, tz);
  if (endsAt <= startsAt) throw new EventError("The event must end after it starts");
  return { input, producer, startsAt, endsAt };
}

/** Returns the new event and the one-time PIN (never stored in clear). */
export async function createEvent(raw: EventInput, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const { input, producer, startsAt, endsAt } = await parseEvent(db, raw);
  const pin = generatePin();
  const event = await db.event.create({
    data: {
      producerId: producer.id,
      cityId: producer.cityId,
      title: input.title,
      description: input.description,
      venue: input.venue,
      address: input.address,
      imageUrls: input.imageUrls,
      tags: input.tags,
      startsAt,
      endsAt,
      status: "DRAFT",
      scannerCode: generateScannerCode(),
      scannerPinHash: hashPin(pin),
    },
  });
  return { event, pin };
}

export async function updateEvent(id: string, raw: EventInput, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const existing = await db.event.findUnique({ where: { id } });
  if (!existing) throw new EventError("Event not found");
  if (existing.status === "FINISHED" || existing.status === "CANCELLED") throw new EventError(`A ${existing.status.toLowerCase()} event can't be edited`);
  const { input, producer, startsAt, endsAt } = await parseEvent(db, raw);
  if (producer.cityId !== existing.cityId) throw new EventError("The producer must be in the event's city");
  return db.event.update({
    where: { id },
    data: {
      producerId: producer.id,
      title: input.title,
      description: input.description,
      venue: input.venue,
      address: input.address,
      imageUrls: input.imageUrls,
      tags: input.tags,
      startsAt,
      endsAt,
    },
  });
}

const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  DRAFT: ["PUBLISHED"],
  PUBLISHED: ["DRAFT", "CANCELLED", "FINISHED"],
  CANCELLED: [],
  FINISHED: [],
};

/**
 * Status transitions. Publishing (first time) stamps publishedAt and fills
 * privateSaleOpensAt = publishedAt + hoursBefore on offers that have no
 * explicit opens-at yet. Cancelling/finishing is status-only here — refunds
 * (Phase 5) and settlement (Phase 8) hook in later.
 */
export async function setEventStatus(id: string, status: EventStatus, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const event = await db.event.findUnique({ where: { id }, include: { offers: true } });
  if (!event) throw new EventError("Event not found");
  if (!TRANSITIONS[event.status].includes(status)) throw new EventError(`Can't go from ${event.status} to ${status}`);
  if (status === "PUBLISHED" && event.offers.length === 0) throw new EventError("Add at least one offer before publishing");

  const data: Prisma.EventUpdateInput = { status };
  if (status === "PUBLISHED" && !event.publishedAt) data.publishedAt = now;
  const updated = await db.event.update({ where: { id }, data });

  if (status === "PUBLISHED") {
    const publishedAt = updated.publishedAt ?? now;
    for (const offer of event.offers) {
      if (offer.privateSaleTiers.length > 0 && offer.privateSaleHoursBefore && !offer.privateSaleOpensAt) {
        await db.offer.update({
          where: { id: offer.id },
          data: { privateSaleOpensAt: new Date(publishedAt.getTime() + offer.privateSaleHoursBefore * 3_600_000) },
        });
      }
    }
  }
  return updated;
}

/** New scanner PIN (the old one stops working). Returns the one-time PIN. */
export async function regenerateScannerPin(id: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const pin = generatePin();
  await db.event.update({ where: { id }, data: { scannerPinHash: hashPin(pin) } });
  return pin;
}

/** Scanner login (Phase 6 uses it): code + PIN → event, within the event window ± a margin. */
export async function authenticateScanner(code: string, pin: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const event = await db.event.findUnique({ where: { scannerCode: code.trim().toUpperCase() } });
  if (!event || !verifyPin(pin.trim(), event.scannerPinHash)) return null;
  return event;
}

/**
 * Duplicate: structural copy (event info + offers) as a DRAFT with new
 * scanner credentials; never redemptions. Dates shift by `shiftDays` so a
 * weekly night can be cloned onto next week in one go.
 */
export async function duplicateEvent(id: string, opts: Opts & { shiftDays?: number } = {}) {
  const db = opts.db ?? defaultPrisma;
  const source = await db.event.findUnique({ where: { id }, include: { offers: { orderBy: { sortOrder: "asc" } } } });
  if (!source) throw new EventError("Event not found");
  const shift = (opts.shiftDays ?? 0) * 86_400_000;
  const pin = generatePin();
  const event = await db.event.create({
    data: {
      producerId: source.producerId,
      cityId: source.cityId,
      title: `${source.title} (copy)`,
      description: source.description,
      venue: source.venue,
      address: source.address,
      imageUrls: source.imageUrls,
      tags: source.tags,
      startsAt: new Date(source.startsAt.getTime() + shift),
      endsAt: new Date(source.endsAt.getTime() + shift),
      status: "DRAFT",
      scannerCode: generateScannerCode(),
      scannerPinHash: hashPin(pin),
      offers: {
        create: source.offers.map((o) => ({
          name: o.name,
          type: o.type,
          keyCost: o.keyCost,
          faceValueCents: o.faceValueCents,
          discountPercent: o.discountPercent,
          allocationType: o.allocationType,
          capacity: o.capacity,
          validUntil: o.validUntil ? new Date(o.validUntil.getTime() + shift) : null,
          afterWindowBehaviour: o.afterWindowBehaviour,
          privateSaleTiers: o.privateSaleTiers,
          privateSaleHoursBefore: o.privateSaleHoursBefore,
          privateSaleOpensAt: null, // recomputed on publish
          openToFree: o.openToFree,
          plusOneAllowed: o.plusOneAllowed,
          plusOneExtraKeyCost: o.plusOneExtraKeyCost,
          plusOneExtraCashCents: o.plusOneExtraCashCents,
          cancellationWindowHours: o.cancellationWindowHours,
          maxPerMember: o.maxPerMember,
          redeemFrom: o.redeemFrom ? new Date(o.redeemFrom.getTime() + shift) : null,
          redeemUntil: o.redeemUntil ? new Date(o.redeemUntil.getTime() + shift) : null,
          sortOrder: o.sortOrder,
        })),
      },
    },
  });
  return { event, pin };
}

/** Redemptions that count against capacity (docs/DATA_MODEL.md). */
export const COUNTING_STATUSES = ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"] as const;

/** Per-offer counters for lists and the event page: redeemed (counting statuses) and checked in. */
export async function offerCounters(offerIds: string[], opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  if (offerIds.length === 0) return new Map<string, { redeemed: number; checkedIn: number }>();
  const rows = await db.redemption.groupBy({
    by: ["offerId", "status"],
    where: { offerId: { in: offerIds }, status: { in: [...COUNTING_STATUSES] } },
    _count: { _all: true },
  });
  const map = new Map<string, { redeemed: number; checkedIn: number }>();
  for (const id of offerIds) map.set(id, { redeemed: 0, checkedIn: 0 });
  for (const r of rows) {
    const c = map.get(r.offerId)!;
    c.redeemed += r._count._all;
    if (r.status === "CHECKED_IN") c.checkedIn += r._count._all;
  }
  return map;
}

/** Form defaults: UTC → the city's wall clock. */
export function eventFormDefaults(event: { startsAt: Date; endsAt: Date }, timezone: string) {
  return { startsAt: utcToLocal(event.startsAt, timezone), endsAt: utcToLocal(event.endsAt, timezone) };
}
