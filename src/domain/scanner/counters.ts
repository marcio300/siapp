import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { offerCounters } from "@/domain/events";

export interface OfferCounter {
  offerId: string;
  name: string;
  type: "FREE_TICKET" | "DISCOUNT_TICKET" | "GUESTLIST";
  allocationType: "CAPPED" | "TIME_WINDOW";
  /** Live redemptions (pending, held, active, checked in). */
  redeemed: number;
  scanned: number;
  /** CAPPED: capacity − redeemed. */
  capacity: number | null;
  remaining: number | null;
  /** TIME_WINDOW: the door window. */
  window: { validUntil: string; open: boolean; minutesLeft: number; afterWindowBehaviour: "PAY_DOOR" | "REFUSE" } | null;
}

export interface ScannerSummary {
  event: { id: string; title: string; venue: string | null; startsAt: string; endsAt: string; status: string; timezone: string };
  offers: OfferCounter[];
  totals: { redeemed: number; scanned: number; scans: number; disputes: number };
  serverTime: string;
}

/** Everything the scanner header shows: per-offer counters and the window status (spec §14). */
export async function scannerSummary(eventId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<ScannerSummary | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const event = await db.event.findUnique({ where: { id: eventId }, include: { city: { select: { timezone: true } }, offers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } });
  if (!event) return null;
  const [counters, scanGroups] = await Promise.all([
    offerCounters(event.offers.map((o) => o.id), { db }),
    db.scan.groupBy({ by: ["disputed"], where: { eventId }, _count: { _all: true } }),
  ]);
  const offers: OfferCounter[] = event.offers.map((o) => {
    const c = counters.get(o.id) ?? { redeemed: 0, checkedIn: 0 };
    const window =
      o.allocationType === "TIME_WINDOW" && o.validUntil
        ? {
            validUntil: o.validUntil.toISOString(),
            open: now <= o.validUntil,
            minutesLeft: Math.max(0, Math.ceil((o.validUntil.getTime() - now.getTime()) / 60_000)),
            afterWindowBehaviour: (o.afterWindowBehaviour === "PAY_DOOR" ? "PAY_DOOR" : "REFUSE") as "PAY_DOOR" | "REFUSE",
          }
        : null;
    return {
      offerId: o.id,
      name: o.name,
      type: o.type,
      allocationType: o.allocationType,
      redeemed: c.redeemed,
      scanned: c.checkedIn,
      capacity: o.allocationType === "CAPPED" ? o.capacity : null,
      remaining: o.allocationType === "CAPPED" && o.capacity !== null ? Math.max(0, o.capacity - c.redeemed) : null,
      window,
    };
  });
  const scans = scanGroups.reduce((n, g) => n + g._count._all, 0);
  const disputes = scanGroups.find((g) => g.disputed)?._count._all ?? 0;
  return {
    event: { id: event.id, title: event.title, venue: event.venue, startsAt: event.startsAt.toISOString(), endsAt: event.endsAt.toISOString(), status: event.status, timezone: event.city.timezone },
    offers,
    totals: { redeemed: offers.reduce((n, o) => n + o.redeemed, 0), scanned: offers.reduce((n, o) => n + o.scanned, 0), scans, disputes },
    serverTime: now.toISOString(),
  };
}
