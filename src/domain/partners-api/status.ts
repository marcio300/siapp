import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { EventError, setEventStatus } from "@/domain/events/events";
import { refundEventRedemptions } from "@/domain/redemption/lifecycle";
import { PartnerApiError } from "./errors";

/**
 * Status mirror (contract §3.4). publish → PUBLISHED (+ clears pause), pause →
 * `pausedAt` (hidden, no new redemptions, live ones untouched), cancel →
 * CANCELLED + keys refunded. For PRODUCER_COLLECTS offers there is no Stripe
 * PaymentIntent on the redemption, so `refundEventRedemptions` refunds keys
 * only — the producer's EventOS runs the cash refunds.
 */
type Opts = { db?: PrismaClient; now?: Date };

export async function findPartnerEvent(producerId: string, eventosEventId: string, db: PrismaClient = defaultPrisma) {
  const event = await db.event.findUnique({ where: { producerId_externalId: { producerId, externalId: eventosEventId } } });
  if (!event || event.source !== "EVENTOS") throw new PartnerApiError(404, "not_found", "Unknown event — push it first");
  return event;
}

function view(e: { id: string; status: string; pausedAt: Date | null }) {
  return { siappEventId: e.id, status: e.status, pausedAt: e.pausedAt?.toISOString() ?? null };
}

export async function publishPartnerEvent(producerId: string, eventosEventId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const event = await findPartnerEvent(producerId, eventosEventId, db);
  if (event.status === "CANCELLED" || event.status === "FINISHED") throw new PartnerApiError(409, "conflict", `The event is ${event.status.toLowerCase()}`);
  if (event.status === "DRAFT") {
    try {
      await setEventStatus(event.id, "PUBLISHED", { db, now });
    } catch (e) {
      if (e instanceof EventError && /offer/.test(e.message)) throw new PartnerApiError(422, "no_offers", "Add at least one offer before publishing");
      throw e;
    }
  }
  const updated = await db.event.update({ where: { id: event.id }, data: { pausedAt: null } });
  return view(updated);
}

export async function pausePartnerEvent(producerId: string, eventosEventId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const event = await findPartnerEvent(producerId, eventosEventId, db);
  if (event.status === "CANCELLED" || event.status === "FINISHED") throw new PartnerApiError(409, "conflict", `The event is ${event.status.toLowerCase()}`);
  const updated = event.pausedAt ? event : await db.event.update({ where: { id: event.id }, data: { pausedAt: now } });
  return view(updated);
}

export async function cancelPartnerEvent(producerId: string, eventosEventId: string, opts: Opts & { reason?: string | null } = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const event = await findPartnerEvent(producerId, eventosEventId, db);
  if (event.status === "FINISHED") throw new PartnerApiError(409, "conflict", "The event has finished");
  if (event.status === "CANCELLED") return { ...view(event), refunded: { redemptions: 0, keys: 0 } };
  const live = await db.redemption.findMany({ where: { eventId: event.id, status: { in: ["ACTIVE", "PENDING_PAYMENT", "HELD"] } }, select: { keyCost: true } });
  const keys = live.reduce((n, r) => n + r.keyCost, 0);
  if (event.status === "PUBLISHED") await setEventStatus(event.id, "CANCELLED", { db, now });
  else await db.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
  const { refunded } = await refundEventRedemptions(event.id, { db, now });
  const updated = await db.event.findUniqueOrThrow({ where: { id: event.id } });
  return { ...view(updated), refunded: { redemptions: refunded, keys } };
}
