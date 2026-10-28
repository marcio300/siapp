import type { PrismaClient, RedemptionStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { processScan, type ScanOutcome } from "./scan";

/**
 * Offline mode (spec §14): the scanner caches this list at login and refreshes
 * it while online, so a dead venue connection still resolves known codes.
 * Scans made offline are queued on the device and replayed through `syncScans`
 * — the server stays the source of truth (a ticket scanned on another door
 * meanwhile comes back ALREADY_SCANNED in the sync report).
 */
export interface ManifestEntry {
  code: string;
  ticketId: string;
  memberName: string;
  plusOneName: string | null;
  photoUrl: string | null;
  offerId: string;
  status: RedemptionStatus;
  checkedInAt: string | null;
}

export interface TicketManifest {
  eventId: string;
  generatedAt: string;
  offers: { id: string; name: string; type: string; validUntil: string | null; afterWindowBehaviour: "PAY_DOOR" | "REFUSE" | null }[];
  tickets: ManifestEntry[];
}

export async function ticketManifest(eventId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<TicketManifest | null> {
  const db = opts.db ?? defaultPrisma;
  const event = await db.event.findUnique({ where: { id: eventId }, include: { offers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } });
  if (!event) return null;
  const tickets = await db.ticket.findMany({
    where: { redemption: { eventId } },
    include: { redemption: { select: { offerId: true, status: true, checkedInAt: true, member: { select: { selfieUrl: true } } } } },
  });
  return {
    eventId,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    offers: event.offers.map((o) => ({ id: o.id, name: o.name, type: o.type, validUntil: o.validUntil?.toISOString() ?? null, afterWindowBehaviour: o.afterWindowBehaviour })),
    tickets: tickets.map((t) => ({
      code: t.qrPayload,
      ticketId: t.id,
      memberName: t.memberName,
      plusOneName: t.plusOneName,
      photoUrl: t.photoSnapshotUrl ?? t.redemption.member.selfieUrl,
      offerId: t.redemption.offerId,
      status: t.redemption.status,
      checkedInAt: t.redemption.checkedInAt?.toISOString() ?? null,
    })),
  };
}

export interface QueuedScan {
  code: string;
  /** ISO timestamp from the device. */
  at: string;
  admitAfterWindow?: boolean;
  /** A dispute flagged while offline rides along and lands on the replayed scan. */
  disputeNote?: string;
}

export interface SyncedScan {
  code: string;
  at: string;
  outcome: ScanOutcome;
}

/** Replay queued offline scans in order. Each one goes through the normal `processScan`. */
export async function syncScans(eventId: string, scans: QueuedScan[], opts: { db?: PrismaClient; now?: Date; scannedBy?: string | null } = {}): Promise<SyncedScan[]> {
  const db = opts.db ?? defaultPrisma;
  const results: SyncedScan[] = [];
  const ordered = [...scans].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const s of ordered) {
    const at = new Date(s.at);
    const outcome = await processScan(
      { eventId, code: s.code, scannedBy: opts.scannedBy, admitAfterWindow: s.admitAfterWindow, at: Number.isNaN(at.getTime()) ? undefined : at },
      { db, now: opts.now },
    );
    if (s.disputeNote?.trim()) {
      const { flagDispute } = await import("./lookup");
      await flagDispute({ eventId, scanId: outcome.scanId, note: s.disputeNote }, { db }).catch(() => undefined);
    }
    results.push({ code: s.code, at: s.at, outcome });
  }
  return results;
}
