import type { PrismaClient, RedemptionStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { ScannerError } from "./errors";

export interface TicketHit {
  code: string; // qrPayload — the scanner submits it exactly like a camera read
  ticketId: string;
  memberName: string;
  plusOneName: string | null;
  photoUrl: string | null;
  offerName: string;
  status: RedemptionStatus;
  checkedInAt: string | null;
}

/** Manual fallback (spec §14): find a ticket on this event by member or +1 name, or by email. */
export async function searchTickets(eventId: string, query: string, opts: { db?: PrismaClient; limit?: number } = {}): Promise<TicketHit[]> {
  const db = opts.db ?? defaultPrisma;
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await db.ticket.findMany({
    where: {
      redemption: { eventId },
      OR: [{ memberName: { contains: q, mode: "insensitive" } }, { plusOneName: { contains: q, mode: "insensitive" } }, { redemption: { member: { email: { contains: q, mode: "insensitive" } } } }],
    },
    include: { redemption: { include: { offer: { select: { name: true } }, member: { select: { selfieUrl: true } } } } },
    orderBy: { memberName: "asc" },
    take: opts.limit ?? 20,
  });
  return rows.map((t) => ({
    code: t.qrPayload,
    ticketId: t.id,
    memberName: t.memberName,
    plusOneName: t.plusOneName,
    photoUrl: t.photoSnapshotUrl ?? t.redemption.member.selfieUrl,
    offerName: t.redemption.offer.name,
    status: t.redemption.status,
    checkedInAt: t.redemption.checkedInAt?.toISOString() ?? null,
  }));
}

/**
 * Door staff flag a dispute on a scan ("says they're not the person on the
 * photo", "+1 didn't match"…). Feeds `AttendanceStats.disputes` once per scan;
 * re-flagging only updates the note.
 */
export async function flagDispute(input: { eventId: string; scanId: string; note: string }, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const note = input.note.trim().slice(0, 500);
  if (!note) throw new ScannerError("Say what the dispute is about");
  return db.$transaction(async (tx) => {
    const scan = await tx.scan.findUnique({ where: { id: input.scanId }, include: { ticket: { include: { redemption: { select: { memberId: true } } } } } });
    if (!scan || scan.eventId !== input.eventId) throw new ScannerError("Scan not found");
    const first = !scan.disputed;
    const updated = await tx.scan.update({ where: { id: scan.id }, data: { disputed: true, disputeNote: note } });
    if (first && scan.ticket) {
      const memberId = scan.ticket.redemption.memberId;
      await tx.attendanceStats.upsert({ where: { memberId }, update: { disputes: { increment: 1 } }, create: { memberId, disputes: 1 } });
    }
    return updated;
  });
}
