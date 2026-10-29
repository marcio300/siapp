import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { toCsv, eur } from "@/lib/csv";
import { formatDate } from "@/lib/format";
import { owedCents } from "./calc";
import { SettlementError } from "./errors";
import { emailSettlementStatement } from "./notify";

interface Opts {
  db?: PrismaClient;
  now?: Date;
}

export const NOTHING_OWED = "nothing-owed";

/**
 * Build the settlement for one FINISHED event (idempotent: an existing row is
 * returned untouched). Lines come from tickets whose redemption is CHECKED_IN
 * on a DISCOUNT_TICKET offer — the door scan is the only thing that puts a
 * ticket on the statement (invariant 10). FREE_TICKET and GUESTLIST settle
 * nothing. An event with nothing owed gets a 0-amount row marked PAID so the
 * hourly job doesn't revisit it and the ledger still shows it was settled.
 */
export async function settleEvent(eventId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const existing = await db.settlement.findUnique({ where: { eventId } });
  if (existing) return { settlement: existing, created: false };
  const event = await db.event.findUnique({ where: { id: eventId }, include: { city: { select: { currency: true } } } });
  if (!event) throw new SettlementError("Event not found");
  if (event.status !== "FINISHED") throw new SettlementError("Only finished events settle");

  const tickets = await db.ticket.findMany({
    where: { redemption: { eventId, status: "CHECKED_IN", offer: { type: "DISCOUNT_TICKET" } } },
    include: { redemption: { include: { offer: { select: { faceValueCents: true, discountPercent: true } } } } },
    orderBy: { issuedAt: "asc" },
  });
  const lines = tickets.map((t) => {
    const face = t.redemption.offer.faceValueCents ?? 0;
    const discount = t.redemption.offer.discountPercent ?? 0;
    return { ticketId: t.id, faceValueCents: face, discountPercent: discount, owedCents: owedCents(face, discount) };
  });
  const amountCents = lines.reduce((n, l) => n + l.owedCents, 0);
  const settlement = await db.settlement.create({
    data: {
      producerId: event.producerId,
      eventId,
      currency: event.city.currency,
      amountCents,
      status: amountCents === 0 ? "PAID" : "OPEN",
      paidAt: amountCents === 0 ? now : null,
      reference: amountCents === 0 ? NOTHING_OWED : null,
      createdAt: now,
      lines: { create: lines },
    },
  });
  return { settlement, created: true };
}

/** Hourly job: every FINISHED event without a settlement gets one, and the producer gets the statement. */
export async function settleEvents(opts: Opts = {}): Promise<{ settled: number; emailed: number; nothingOwed: number }> {
  const db = opts.db ?? defaultPrisma;
  const events = await db.event.findMany({ where: { status: "FINISHED", settlements: { none: {} } }, select: { id: true }, orderBy: { endsAt: "asc" } });
  const out = { settled: 0, emailed: 0, nothingOwed: 0 };
  for (const e of events) {
    const { settlement, created } = await settleEvent(e.id, opts);
    if (!created) continue;
    out.settled++;
    if (settlement.amountCents === 0) {
      out.nothingOwed++;
      continue;
    }
    if (await sendSettlementEmail(settlement.id, opts)) out.emailed++;
  }
  return out;
}

export async function markSettlementPaid(id: string, input: { reference: string; staffId?: string | null }, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const reference = input.reference.trim().slice(0, 120);
  if (!reference) throw new SettlementError("Enter the payment reference (bank transfer id, invoice number…)");
  const res = await db.settlement.updateMany({ where: { id, status: "OPEN" }, data: { status: "PAID", paidAt: now, reference } });
  if (res.count === 0) throw new SettlementError("Settlement is already paid (or doesn't exist)");
  return db.settlement.findUniqueOrThrow({ where: { id } });
}

export async function reopenSettlement(id: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const res = await db.settlement.updateMany({ where: { id, status: "PAID", amountCents: { gt: 0 } }, data: { status: "OPEN", paidAt: null, reference: null } });
  if (res.count === 0) throw new SettlementError("Only a paid settlement with an amount can be reopened");
  return db.settlement.findUniqueOrThrow({ where: { id } });
}

export interface StatementRow {
  ticketId: string;
  memberName: string;
  plusOneName: string | null;
  offerName: string;
  scannedAt: Date | null;
  faceValueCents: number;
  discountPercent: number;
  owedCents: number;
}

export async function settlementStatement(id: string, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const s = await db.settlement.findUnique({
    where: { id },
    include: {
      producer: true,
      event: { include: { city: { select: { timezone: true, name: true } } } },
      lines: { orderBy: { id: "asc" } },
    },
  });
  if (!s) throw new SettlementError("Settlement not found");
  const tickets = await db.ticket.findMany({
    where: { id: { in: s.lines.map((l) => l.ticketId) } },
    include: { redemption: { select: { checkedInAt: true, offer: { select: { name: true } } } } },
  });
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const rows: StatementRow[] = s.lines.map((l) => {
    const t = byId.get(l.ticketId);
    return {
      ticketId: l.ticketId,
      memberName: t?.memberName ?? "—",
      plusOneName: t?.plusOneName ?? null,
      offerName: t?.redemption.offer.name ?? "—",
      scannedAt: t?.redemption.checkedInAt ?? null,
      faceValueCents: l.faceValueCents,
      discountPercent: l.discountPercent,
      owedCents: l.owedCents,
    };
  });
  rows.sort((a, b) => (a.scannedAt?.getTime() ?? 0) - (b.scannedAt?.getTime() ?? 0));
  return { settlement: s, rows };
}

export function statementCsv(input: { event: { title: string }; timezone: string; rows: StatementRow[]; amountCents: number; currency: string }): string {
  const rows = input.rows.map((r) => [
    r.scannedAt ? formatDate(r.scannedAt, input.timezone) : "",
    r.memberName,
    r.plusOneName ?? "",
    r.offerName,
    eur(r.faceValueCents),
    r.discountPercent,
    eur(r.owedCents),
  ]);
  rows.push(["", "", "", "TOTAL", "", "", eur(input.amountCents)]);
  return toCsv(["scanned_at", "member", "plus_one", "offer", `face_${input.currency.toLowerCase()}`, "discount_percent", `owed_${input.currency.toLowerCase()}`], rows);
}

export function statementFilename(event: { title: string; startsAt: Date }): string {
  const slug = event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
  return `settlement-${event.startsAt.toISOString().slice(0, 10)}-${slug}.csv`;
}

/** Email the statement (CSV attached) to the producer's contact. Returns false when there's nobody to send to. */
export async function sendSettlementEmail(id: string, opts: Opts = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const { settlement, rows } = await settlementStatement(id, { db });
  if (!settlement.producer.contactEmail) return false;
  const tz = settlement.event.city.timezone;
  const csv = statementCsv({ event: settlement.event, timezone: tz, rows, amountCents: settlement.amountCents, currency: settlement.currency });
  await emailSettlementStatement({
    to: settlement.producer.contactEmail,
    producerName: settlement.producer.name,
    eventTitle: settlement.event.title,
    startsAt: settlement.event.startsAt,
    timezone: tz,
    scannedCount: rows.length,
    amountCents: settlement.amountCents,
    currency: settlement.currency,
    status: settlement.status,
    reference: settlement.reference,
    csv,
    filename: statementFilename(settlement.event),
  });
  await db.settlement.update({ where: { id }, data: { emailedAt: now } });
  return true;
}
