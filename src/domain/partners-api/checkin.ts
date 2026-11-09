import type { Prisma, PrismaClient, RedemptionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "@/lib/db";
import { PartnerApiError, validationFailed } from "./errors";
import { notifySalesUpdated } from "./hooks";

/**
 * `POST /redemptions/{id}/checkin` (contract §3.7): the producer's EventOS
 * scanner admitted a SIAPP ticket. Mirrors the OK branch of our own
 * `processScan` — a conditional ACTIVE → CHECKED_IN flip, `shows++`, one
 * `Scan` row (`source = EVENTOS`) — idempotent by `eventosCheckInId`. A
 * late report for a redemption we already marked NO_SHOW reverses it when it
 * arrives within 48 h of the event's end (offline scanners sync late).
 */
export const CheckinSchema = z.object({
  at: z.string().datetime({ offset: true }),
  gate: z.string().trim().max(120).optional().nullable(),
  device: z.string().trim().max(120).optional().nullable(),
  eventosCheckInId: z.string().trim().min(1).max(200),
});

export const NO_SHOW_REVERSAL_HOURS = 48;

export type ExternalCheckinResult = "OK" | "ALREADY_SCANNED" | "CANCELLED" | "INVALID";

export interface ExternalCheckinOutcome {
  result: ExternalCheckinResult;
  redemptionStatus: RedemptionStatus;
  message: string;
  firstScanAt?: string;
  reversedNoShow?: boolean;
  replay?: boolean;
}

type Opts = { db?: PrismaClient; now?: Date };

export async function recordExternalCheckIn(producerId: string, redemptionId: string, raw: unknown, opts: Opts = {}): Promise<ExternalCheckinOutcome> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = CheckinSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join("."), code: "invalid", message: i.message })));
  const input = parsed.data;

  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { ticket: true, event: true } });
  if (!r) throw new PartnerApiError(404, "not_found", "Unknown redemption");
  if (r.event.producerId !== producerId) throw new PartnerApiError(403, "forbidden", "This redemption belongs to another producer");

  // Idempotency: the same EventOS check-in id always gets the same answer.
  const prior = await db.scan.findUnique({ where: { externalId: input.eventosCheckInId } });
  if (prior) {
    const fresh = await db.redemption.findUniqueOrThrow({ where: { id: r.id }, select: { status: true, checkedInAt: true } });
    const result = prior.result === "OK" ? "OK" : prior.result === "ALREADY_SCANNED" ? "ALREADY_SCANNED" : prior.result === "CANCELLED" ? "CANCELLED" : "INVALID";
    return { result, redemptionStatus: fresh.status, message: messageFor(result, fresh.status), firstScanAt: fresh.checkedInAt?.toISOString(), replay: true };
  }

  const requested = new Date(input.at);
  const earliest = r.event.startsAt.getTime() - 24 * 3_600_000;
  const at = requested.getTime() >= earliest && requested.getTime() <= now.getTime() ? requested : now;
  const scannedBy = `eventos:${input.gate?.trim() || input.device?.trim() || "door"}`;
  const record = (client: Prisma.TransactionClient | PrismaClient, result: ExternalCheckinResult) =>
    client.scan.create({ data: { eventId: r.eventId, ticketId: r.ticket?.id ?? null, result, scannedBy, source: "EVENTOS", externalId: input.eventosCheckInId, scannedAt: at } });

  const finish = async (result: ExternalCheckinResult, status: RedemptionStatus, extra: Partial<ExternalCheckinOutcome> = {}): Promise<ExternalCheckinOutcome> => {
    await record(db, result);
    return { result, redemptionStatus: status, message: messageFor(result, status), ...extra };
  };

  if (!r.ticket) return finish("INVALID", r.status);
  if (r.status === "CHECKED_IN") return finish("ALREADY_SCANNED", r.status, { firstScanAt: (r.checkedInAt ?? r.updatedAt).toISOString() });
  if (r.status === "PENDING_PAYMENT" || r.status === "HELD") return finish("INVALID", r.status);
  if (r.status === "CANCELLED" || r.status === "EXPIRED" || r.status === "DENIED") return finish("CANCELLED", r.status);

  if (r.status === "NO_SHOW") {
    if (now.getTime() - r.event.endsAt.getTime() > NO_SHOW_REVERSAL_HOURS * 3_600_000) return finish("CANCELLED", r.status);
    const out = await db.$transaction(async (tx) => {
      const flipped = await tx.redemption.updateMany({ where: { id: r.id, status: "NO_SHOW" }, data: { status: "CHECKED_IN", checkedInAt: at } });
      if (flipped.count === 0) {
        const fresh = await tx.redemption.findUniqueOrThrow({ where: { id: r.id }, select: { status: true, checkedInAt: true } });
        const result: ExternalCheckinResult = fresh.status === "CHECKED_IN" ? "ALREADY_SCANNED" : "CANCELLED";
        await record(tx, result);
        return { result, redemptionStatus: fresh.status, message: messageFor(result, fresh.status), firstScanAt: fresh.checkedInAt?.toISOString() } as ExternalCheckinOutcome;
      }
      const stats = await tx.attendanceStats.findUnique({ where: { memberId: r.memberId } });
      await tx.attendanceStats.upsert({
        where: { memberId: r.memberId },
        update: { shows: { increment: 1 }, noShows: stats && stats.noShows > 0 ? { decrement: 1 } : undefined },
        create: { memberId: r.memberId, shows: 1 },
      });
      await record(tx, "OK");
      return { result: "OK", redemptionStatus: "CHECKED_IN", message: "Welcome in (no-show reversed)", firstScanAt: at.toISOString(), reversedNoShow: true } as ExternalCheckinOutcome;
    });
    if (out.result === "OK") await notifySalesUpdated(r.eventId, { db, now });
    return out;
  }

  // ACTIVE: the door already enforced any guest-list window.
  const out = await db.$transaction(async (tx) => {
    const flipped = await tx.redemption.updateMany({ where: { id: r.id, status: "ACTIVE" }, data: { status: "CHECKED_IN", checkedInAt: at } });
    if (flipped.count === 0) {
      const fresh = await tx.redemption.findUniqueOrThrow({ where: { id: r.id }, select: { status: true, checkedInAt: true, updatedAt: true } });
      const result: ExternalCheckinResult = fresh.status === "CHECKED_IN" ? "ALREADY_SCANNED" : "CANCELLED";
      await record(tx, result);
      return { result, redemptionStatus: fresh.status, message: messageFor(result, fresh.status), firstScanAt: (fresh.checkedInAt ?? fresh.updatedAt).toISOString() } as ExternalCheckinOutcome;
    }
    await tx.attendanceStats.upsert({ where: { memberId: r.memberId }, update: { shows: { increment: 1 } }, create: { memberId: r.memberId, shows: 1 } });
    await record(tx, "OK");
    return { result: "OK", redemptionStatus: "CHECKED_IN", message: "Welcome in", firstScanAt: at.toISOString() } as ExternalCheckinOutcome;
  });
  if (out.result === "OK") await notifySalesUpdated(r.eventId, { db, now });
  return out;
}

function messageFor(result: ExternalCheckinResult, status: RedemptionStatus): string {
  switch (result) {
    case "OK":
      return "Welcome in";
    case "ALREADY_SCANNED":
      return "Already scanned";
    case "CANCELLED":
      return status === "NO_SHOW" ? "Marked no-show — too late to reverse" : `Ticket is ${status.toLowerCase().replace("_", " ")}`;
    default:
      return status === "PENDING_PAYMENT" ? "Not paid yet — no ticket" : status === "HELD" ? "Under review — do not admit" : "No ticket";
  }
}
