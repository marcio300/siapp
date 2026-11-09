import type { Offer, Prisma, PrismaClient, RedemptionStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { inviteeLabel } from "@/domain/referrals/status";
import { TYPE_TO_MODE, memberPriceCents } from "./pricing";

/**
 * Read models for the partner API: OfferResult (contract §2.4) and
 * RedemptionView (§2.5) with the `since`/cursor pagination of §3.5.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface OfferCounters {
  pendingPayment: number;
  held: number;
  active: number;
  checkedIn: number;
  cancelled: number;
}

export interface OfferResult {
  ref: string | null;
  siappOfferId: string;
  type: Offer["type"];
  mode: "FULL" | "DISCOUNT" | "GUESTLIST";
  paymentMode: Offer["paymentMode"];
  keyCost: number;
  memberPriceCents: number | null;
  frozen: boolean;
  capacity: number | null;
  discountPercent: number | null;
  counters: OfferCounters;
}

const EMPTY: OfferCounters = { pendingPayment: 0, held: 0, active: 0, checkedIn: 0, cancelled: 0 };

export async function offerCountersByStatus(db: Db, offerIds: string[]): Promise<Map<string, OfferCounters>> {
  const map = new Map<string, OfferCounters>();
  for (const id of offerIds) map.set(id, { ...EMPTY });
  if (offerIds.length === 0) return map;
  const rows = await db.redemption.groupBy({ by: ["offerId", "status"], where: { offerId: { in: offerIds } }, _count: { _all: true } });
  const slot: Partial<Record<RedemptionStatus, keyof OfferCounters>> = { PENDING_PAYMENT: "pendingPayment", HELD: "held", ACTIVE: "active", CHECKED_IN: "checkedIn", CANCELLED: "cancelled" };
  for (const r of rows) {
    const k = slot[r.status];
    if (k) map.get(r.offerId)![k] += r._count._all;
  }
  return map;
}

export function toOfferResult(o: Offer, c: OfferCounters, live: number): OfferResult {
  return {
    ref: o.externalRef,
    siappOfferId: o.id,
    type: o.type,
    mode: TYPE_TO_MODE[o.type],
    paymentMode: o.paymentMode,
    keyCost: o.keyCost,
    memberPriceCents: o.type === "DISCOUNT_TICKET" ? memberPriceCents(o.faceValueCents ?? 0, o.discountPercent ?? 0) : null,
    frozen: live > 0 || c.pendingPayment + c.held + c.active + c.checkedIn > 0,
    capacity: o.capacity,
    discountPercent: o.discountPercent,
    counters: c,
  };
}

export interface RedemptionView {
  id: string;
  offerRef: string | null;
  status: RedemptionStatus;
  member: { displayName: string; email: string | null };
  plusOneName: string | null;
  keyCost: number;
  cashCents: number;
  qrPayload: string | null;
  externalOrderId: string | null;
  externalTicketId: string | null;
  redeemedAt: string;
  checkedInAt: string | null;
  cancelledAt: string | null;
  cancelDeadlineAt: string;
  updatedAt: string;
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string | null | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const [t, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const updatedAt = t ? new Date(t) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || !id) return null;
  return { updatedAt, id };
}

/** Contract §3.5: redemptions ordered by updatedAt asc; `since` filters, `cursor` pages. */
export async function salesForEvent(eventId: string, opts: { since?: string | null; cursor?: string | null; limit?: number; db?: Db } = {}) {
  const db = opts.db ?? defaultPrisma;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const since = opts.since ? new Date(opts.since) : null;
  const cur = decodeCursor(opts.cursor);
  const where: Prisma.RedemptionWhereInput = {
    eventId,
    ...(since && !Number.isNaN(since.getTime()) ? { updatedAt: { gt: since } } : {}),
    ...(cur ? { OR: [{ updatedAt: { gt: cur.updatedAt } }, { updatedAt: cur.updatedAt, id: { gt: cur.id } }] } : {}),
  };
  const rows = await db.redemption.findMany({
    where,
    include: { member: { select: { name: true, email: true } }, offer: { select: { externalRef: true } }, ticket: { select: { qrPayload: true } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const redemptions: RedemptionView[] = page.map((r) => ({
    id: r.id,
    offerRef: r.offer.externalRef,
    status: r.status,
    // Decision C: the producer gets the email only when the member is their buyer (cash paid).
    member: { displayName: inviteeLabel(r.member), email: r.cashCents > 0 ? r.member.email : null },
    plusOneName: r.plusOneName,
    keyCost: r.keyCost,
    cashCents: r.cashCents,
    qrPayload: r.ticket?.qrPayload ?? null,
    externalOrderId: null,
    externalTicketId: null,
    redeemedAt: r.createdAt.toISOString(),
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelDeadlineAt: r.cancelDeadlineAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
  return { redemptions, nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last.id) : null };
}
