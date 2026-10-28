import type { Prisma, PrismaClient, RedemptionStatus, ScanResult } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { verifyQrSignature } from "@/domain/redemption/tickets";

/** What the door sees after a scan — the photo is deliberately first-class (spec §14). */
export interface TicketCard {
  ticketId: string;
  redemptionId: string;
  memberName: string;
  plusOneName: string | null;
  photoUrl: string | null;
  offerName: string;
  offerType: "FREE_TICKET" | "DISCOUNT_TICKET" | "GUESTLIST";
  status: RedemptionStatus;
}

export interface ScanOutcome {
  result: ScanResult;
  message: string;
  scanId: string;
  ticket?: TicketCard;
  /** ALREADY_SCANNED: when the ticket first went through. */
  firstScanAt?: string;
  /** OK: when this check-in was recorded. */
  checkedInAt?: string;
  /** WINDOW_CLOSED: what the offer says to do now. */
  afterWindow?: { behaviour: "PAY_DOOR" | "REFUSE"; validUntil: string };
}

export interface ScanInput {
  eventId: string;
  /** The QR payload (or a code typed at the door). */
  code: string;
  /** Door device label from the scanner session — stored as `Scan.scannedBy`. */
  scannedBy?: string | null;
  /** Staff decision after WINDOW_CLOSED on a PAY_DOOR offer: the guest paid, let them in. */
  admitAfterWindow?: boolean;
  /** When the scan physically happened (offline queue replay); clamped to a sane range. */
  at?: Date;
}

interface Opts {
  db?: PrismaClient;
  now?: Date;
}

const ENDED: RedemptionStatus[] = ["CANCELLED", "EXPIRED", "DENIED", "NO_SHOW"];

function endedMessage(status: RedemptionStatus): string {
  switch (status) {
    case "CANCELLED":
      return "Ticket was cancelled";
    case "EXPIRED":
      return "Payment never completed — no ticket";
    case "DENIED":
      return "Refused by review — do not admit";
    case "NO_SHOW":
      return "Marked no-show — the event is over";
    default:
      return "Ticket is not valid";
  }
}

/**
 * Validate one scanned code against the event the door is signed into and
 * record the attempt. Every call writes exactly one `Scan` row; an OK result
 * flips the redemption ACTIVE → CHECKED_IN atomically (conditional updateMany,
 * so two doors scanning the same QR at once produce one OK and one
 * ALREADY_SCANNED) and bumps `AttendanceStats.shows`.
 */
export async function processScan(input: ScanInput, opts: Opts = {}): Promise<ScanOutcome> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const code = input.code.trim();
  const scannedBy = input.scannedBy ?? null;

  const ticket = code
    ? await db.ticket.findUnique({
        where: { qrPayload: code },
        include: {
          redemption: {
            include: {
              offer: true,
              event: { select: { id: true, title: true, startsAt: true } },
              member: { select: { selfieUrl: true } },
            },
          },
        },
      })
    : null;

  const record = (data: { result: ScanResult; ticketId?: string | null; rawPayload?: string | null; scannedAt?: Date }, client: PrismaClient | Prisma.TransactionClient = db) =>
    client.scan.create({
      data: {
        eventId: input.eventId,
        result: data.result,
        ticketId: data.ticketId ?? null,
        rawPayload: data.rawPayload ?? null,
        scannedBy,
        scannedAt: data.scannedAt ?? now,
      },
    });

  // Unknown code, or one whose stored signature doesn't match (tampered row / wrong secret).
  if (!ticket || !verifyQrSignature(ticket.qrPayload, ticket.signature)) {
    const scan = await record({ result: "INVALID", ticketId: ticket?.id ?? null, rawPayload: code.slice(0, 200) });
    return { result: "INVALID", message: ticket ? "Ticket signature doesn't match — do not admit" : "Not a SIAPP ticket", scanId: scan.id };
  }

  const r = ticket.redemption;
  const card: TicketCard = {
    ticketId: ticket.id,
    redemptionId: r.id,
    memberName: ticket.memberName,
    plusOneName: ticket.plusOneName,
    photoUrl: ticket.photoSnapshotUrl ?? r.member.selfieUrl,
    offerName: r.offer.name,
    offerType: r.offer.type,
    status: r.status,
  };
  const done = async (result: ScanResult, message: string, extra: Partial<ScanOutcome> = {}): Promise<ScanOutcome> => {
    const scan = await record({ result, ticketId: ticket.id });
    return { result, message, scanId: scan.id, ticket: card, ...extra };
  };

  if (r.eventId !== input.eventId) return done("INVALID", `Ticket is for “${r.event.title}”, not this event`);
  if (r.status === "CHECKED_IN") return done("ALREADY_SCANNED", "Already scanned", { firstScanAt: (r.checkedInAt ?? r.updatedAt).toISOString() });
  if (ENDED.includes(r.status)) return done("CANCELLED", endedMessage(r.status));
  if (r.status === "PENDING_PAYMENT") return done("INVALID", "Not paid yet — no ticket");
  if (r.status === "HELD") return done("INVALID", "Under review — do not admit");

  // ACTIVE from here. Time-window offers close at validUntil.
  const offer = r.offer;
  if (offer.allocationType === "TIME_WINDOW" && offer.validUntil && now > offer.validUntil) {
    const behaviour = offer.afterWindowBehaviour === "PAY_DOOR" ? "PAY_DOOR" : "REFUSE";
    const admit = behaviour === "PAY_DOOR" && input.admitAfterWindow === true;
    if (!admit) {
      return done("WINDOW_CLOSED", behaviour === "PAY_DOOR" ? "Window closed — guest pays at the door" : "Window closed — refuse entry", {
        afterWindow: { behaviour, validUntil: offer.validUntil.toISOString() },
      });
    }
  }

  // Honour the device's timestamp for offline replays, within reason.
  const earliest = r.event.startsAt.getTime() - 24 * 3_600_000;
  const at = input.at && input.at.getTime() >= earliest && input.at.getTime() <= now.getTime() ? input.at : now;

  return db.$transaction(async (tx) => {
    const flipped = await tx.redemption.updateMany({ where: { id: r.id, status: "ACTIVE" }, data: { status: "CHECKED_IN", checkedInAt: at } });
    if (flipped.count === 0) {
      const fresh = await tx.redemption.findUniqueOrThrow({ where: { id: r.id }, select: { status: true, checkedInAt: true, updatedAt: true } });
      const scan = await record({ result: fresh.status === "CHECKED_IN" ? "ALREADY_SCANNED" : "CANCELLED", ticketId: ticket.id }, tx);
      return fresh.status === "CHECKED_IN"
        ? { result: "ALREADY_SCANNED" as const, message: "Already scanned", scanId: scan.id, ticket: { ...card, status: fresh.status }, firstScanAt: (fresh.checkedInAt ?? fresh.updatedAt).toISOString() }
        : { result: "CANCELLED" as const, message: endedMessage(fresh.status), scanId: scan.id, ticket: { ...card, status: fresh.status } };
    }
    await tx.attendanceStats.upsert({ where: { memberId: r.memberId }, update: { shows: { increment: 1 } }, create: { memberId: r.memberId, shows: 1 } });
    const scan = await record({ result: "OK", ticketId: ticket.id, scannedAt: at }, tx);
    return {
      result: "OK" as const,
      message: ticket.plusOneName ? `Welcome in — ${ticket.memberName} +1` : "Welcome in",
      scanId: scan.id,
      ticket: { ...card, status: "CHECKED_IN" as const },
      checkedInAt: at.toISOString(),
    };
  });
}
