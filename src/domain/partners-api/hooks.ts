import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { inviteeLabel } from "@/domain/referrals/status";
import { signedPhotoUrl } from "./photo";
import { flushOutbound, queueOutbound } from "./outbox";
import { revokeProducerApiKeys } from "./keys";
import { unbindProducer } from "./connect";

/**
 * Where the domain tells EventOS what happened (contract §4). Every hook is
 * best-effort: it never throws into the business operation that called it,
 * only logs. Nothing is sent for events we manage ourselves (`source = MANUAL`).
 *
 * Mirror tickets (§4.1) exist only for FULL (FREE_TICKET) and GUESTLIST offers;
 * DISCOUNT_TICKET redemptions are activated by EventOS itself through
 * `order.paid` (Phase 13) — sending `redemption.activated` for them would loop.
 */
type Db = PrismaClient | Prisma.TransactionClient;
type Opts = { db?: Db; now?: Date; /** deliver right away (default) or leave it to the cron */ deliver?: boolean };

export type CancelReason = "member" | "staff" | "event_cancelled" | "denied" | "expired";

/** Coalescing window for `sales.updated`: one message per event per 30 s. */
export const SALES_UPDATED_WINDOW_MS = 30_000;

function swallow(label: string, e: unknown) {
  console.error(`[partner-hooks] ${label}`, e instanceof Error ? e.message : e);
}

async function deliverNow(ids: (string | null | undefined)[], opts: Opts) {
  const list = ids.filter((x): x is string => !!x);
  if (list.length === 0 || opts.deliver === false) return;
  // Only the root client can run the flush (it opens its own connection); inside a tx the cron picks it up.
  const db = opts.db as PrismaClient | undefined;
  if (db && !("$transaction" in db)) return;
  try {
    await flushOutbound({ db, now: opts.now, ids: list });
  } catch (e) {
    swallow("deliver", e);
  }
}

export function ticketTypeIdFromRef(ref: string | null): string | null {
  if (!ref) return null;
  const parts = ref.split(":");
  return parts.length >= 3 ? parts[parts.length - 2]! : null;
}

/** A redemption on an EventOS event became ACTIVE (and has its ticket). */
export async function notifyRedemptionActivated(redemptionId: string, opts: Opts = {}): Promise<string | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  try {
    const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { member: true, offer: true, ticket: true, event: { include: { producer: true } } } });
    if (!r || r.event.source !== "EVENTOS" || !r.event.externalId || !r.ticket) return null;
    if (r.offer.type === "DISCOUNT_TICKET") return null;
    const photo = await signedPhotoUrl(r.event.producer, r.ticket.id, r.event.endsAt, { db: db as PrismaClient, now });
    const data = {
      redemptionId: r.id,
      siappEventId: r.eventId,
      eventosEventId: r.event.externalId,
      offerRef: r.offer.externalRef,
      ticketTypeId: ticketTypeIdFromRef(r.offer.externalRef),
      qrPayload: r.ticket.qrPayload,
      member: { displayName: inviteeLabel(r.member) },
      plusOneName: r.plusOneName,
      photoUrl: r.ticket.photoSnapshotUrl ? photo?.url ?? null : null,
      photoExpiresAt: r.ticket.photoSnapshotUrl ? photo?.expiresAt.toISOString() ?? null : null,
      keyCost: r.keyCost,
      window: r.offer.type === "GUESTLIST" && r.offer.validUntil ? { validUntil: r.offer.validUntil.toISOString(), afterWindow: r.offer.afterWindowBehaviour ?? "REFUSE" } : null,
      redeemedAt: r.createdAt.toISOString(),
    };
    const row = await queueOutbound(r.event.producer, "redemption.activated", data, { db, now, eventId: r.eventId });
    const sales = await queueSalesUpdated(r.eventId, { db, now });
    await deliverNow([row?.id, sales], opts);
    return row?.id ?? null;
  } catch (e) {
    swallow("redemption.activated", e);
    return null;
  }
}

/** A redemption on an EventOS event ended (member/staff cancel, denial, expiry, event cancelled). */
export async function notifyRedemptionCancelled(redemptionId: string, reason: CancelReason, input: { wasActive: boolean; cashCents: number }, opts: Opts = {}): Promise<string | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  try {
    const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { event: { include: { producer: true } } } });
    if (!r || r.event.source !== "EVENTOS" || !r.event.externalId) return null;
    const data = { redemptionId: r.id, cancelledAt: (r.cancelledAt ?? now).toISOString(), reason, refundCash: input.wasActive && input.cashCents > 0 };
    const row = await queueOutbound(r.event.producer, "redemption.cancelled", data, { db, now, eventId: r.eventId });
    const sales = await queueSalesUpdated(r.eventId, { db, now });
    await deliverNow([row?.id, sales], opts);
    return row?.id ?? null;
  } catch (e) {
    swallow("redemption.cancelled", e);
    return null;
  }
}

/** Our scanner admitted a ticket on an EventOS event. */
export async function notifyTicketCheckedIn(input: { redemptionId: string; qrPayload: string; at: Date; gate: string | null; scanId: string }, opts: Opts = {}): Promise<string | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  try {
    const r = await db.redemption.findUnique({ where: { id: input.redemptionId }, include: { event: { include: { producer: true } } } });
    if (!r || r.event.source !== "EVENTOS" || !r.event.externalId) return null;
    const data = { redemptionId: r.id, qrPayload: input.qrPayload, at: input.at.toISOString(), gate: input.gate ?? "SIAPP door", siappScanId: input.scanId };
    const row = await queueOutbound(r.event.producer, "ticket.checked_in", data, { db, now, eventId: r.eventId });
    const sales = await queueSalesUpdated(r.eventId, { db, now });
    await deliverNow([row?.id, sales], opts);
    return row?.id ?? null;
  } catch (e) {
    swallow("ticket.checked_in", e);
    return null;
  }
}

/** Counters changed on an EventOS event: one coalesced nudge per event per 30 s. Returns the row id when a NEW row was armed. */
export async function queueSalesUpdated(eventId: string, opts: Opts = {}): Promise<string | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  try {
    const e = await db.event.findUnique({ where: { id: eventId }, include: { producer: true } });
    if (!e || e.source !== "EVENTOS" || !e.externalId) return null;
    const key = `sales:${e.id}`;
    const existing = await db.outboundEvent.findUnique({ where: { dedupeKey: key } });
    if (existing?.status === "PENDING") return null;
    const notBefore = existing?.sentAt && existing.sentAt.getTime() + SALES_UPDATED_WINDOW_MS > now.getTime() ? new Date(existing.sentAt.getTime() + SALES_UPDATED_WINDOW_MS) : now;
    const row = await queueOutbound(e.producer, "sales.updated", { siappEventId: e.id, eventosEventId: e.externalId }, { db, now, eventId: e.id, dedupeKey: key, notBefore });
    return row?.id ?? null;
  } catch (e) {
    swallow("sales.updated", e);
    return null;
  }
}

/** Convenience for callers that only know the event changed (no-shows, pause…). */
export async function notifySalesUpdated(eventId: string, opts: Opts = {}): Promise<void> {
  const id = await queueSalesUpdated(eventId, opts);
  await deliverNow([id], opts);
}

/**
 * Staff revoked the key or unbound the producer: tell EventOS first (while we
 * still hold the secret), deliver immediately, then forget the connection.
 */
export async function disconnectProducer(producerId: string, reason: "key_revoked" | "staff", opts: { db?: PrismaClient; now?: Date; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const producer = await db.producer.findUnique({ where: { id: producerId } });
  if (!producer) return;
  try {
    const row = await queueOutbound(producer, "producer.disconnected", { reason }, { db, now });
    if (row) await flushOutbound({ db, now, ids: [row.id], fetchImpl: opts.fetchImpl });
  } catch (e) {
    swallow("producer.disconnected", e);
  }
  await revokeProducerApiKeys(producerId, { db, now });
  if (reason === "staff") await unbindProducer(producerId, db);
}
