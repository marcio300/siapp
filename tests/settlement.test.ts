import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { setEmailSinkForTests, type SendEmailInput } from "@/lib/email";
import { addOffer, createEvent, setEventStatus, type OfferInput } from "@/domain/events";
import { createProducer } from "@/domain/producers";
import { issueTicket } from "@/domain/redemption";
import { processScan } from "@/domain/scanner";
import { NOTHING_OWED, SettlementError, markSettlementPaid, owedCents, reopenSettlement, sendSettlementEmail, settleEvent, settleEvents, settlementStatement, statementCsv } from "@/domain/settlement";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const HOUR = 3_600_000;
let producerId: string;
let cityId: string;
const sent: SendEmailInput[] = [];

async function eventWith(offers: OfferInput[], status: "PUBLISHED" | "FINISHED" = "FINISHED", producer = producerId) {
  const start = new Date(Date.now() - 10 * HOUR);
  const end = new Date(start.getTime() + 5 * HOUR);
  const local = (d: Date) => ({ date: d.toISOString().slice(0, 10), time: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` });
  const { event } = await createEvent({ producerId: producer, title: `Night ${start.getTime()}`, startsAt: local(start), endsAt: local(end) });
  const created = [];
  for (const o of offers) created.push(await addOffer(event.id, o));
  await setEventStatus(event.id, "PUBLISHED");
  if (status === "FINISHED") await setEventStatus(event.id, "FINISHED");
  return { event: await prisma.event.findUniqueOrThrow({ where: { id: event.id } }), offers: created };
}

async function ticket(eventId: string, offerId: string, status: "ACTIVE" | "CHECKED_IN" | "NO_SHOW" | "CANCELLED", name = "Ana", plusOne: string | null = null) {
  const m = await createMember();
  const r = await prisma.redemption.create({ data: { memberId: m.id, offerId, eventId, status, keyCost: 10, plusOneName: plusOne, cancelDeadlineAt: new Date(), checkedInAt: status === "CHECKED_IN" ? new Date() : null } });
  return issueTicket(prisma, { redemptionId: r.id, memberName: name, photoSnapshotUrl: null, plusOneName: plusOne });
}

describe("settlements", () => {
  beforeAll(async () => {
    await resetDatabase();
    cityId = (await runSeed(prisma, { adminEmail: "admin@test.siapp" })).cityId;
    producerId = (await createProducer({ name: "Lux", cityId, contactEmail: "money@lux.test" })).id;
    setEmailSinkForTests(async (m) => {
      sent.push(m);
    });
  });

  it("owedCents = face × (1 − discount%) in integer cents, half up", () => {
    expect(owedCents(2000, 40)).toBe(1200);
    expect(owedCents(1999, 33)).toBe(1339); // 1339.33
    expect(owedCents(1250, 33)).toBe(838); // 837.5 → up
    expect(owedCents(1, 50)).toBe(1); // 0.5 → up
    expect(owedCents(1, 51)).toBe(0); // 0.49 → down
    expect(owedCents(1000, 0)).toBe(1000);
    expect(owedCents(1000, 100)).toBe(0);
    expect(() => owedCents(10.5, 10)).toThrow(RangeError);
    expect(() => owedCents(1000, 101)).toThrow(RangeError);
  });

  it("invariant 10: only scanned discounted tickets settle; free/guest-list never; idempotent; statement + CSV", async () => {
    const { event, offers } = await eventWith([
      { name: "Discount", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "20", discountPercent: "40", allocationType: "CAPPED", capacity: 50 },
      { name: "Odd", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "12.50", discountPercent: "33", allocationType: "CAPPED", capacity: 50 },
      { name: "Free", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 50 },
      { name: "Guest list", type: "GUESTLIST", keyCost: 5, allocationType: "TIME_WINDOW", validUntilLocal: "02:00", afterWindowBehaviour: "REFUSE" },
    ]);
    const [discount, odd, free, guest] = offers.map((o) => o.id);
    const a = await ticket(event.id, discount!, "CHECKED_IN", "Ana Silva");
    const b = await ticket(event.id, discount!, "CHECKED_IN", "=Bruno", "Zé"); // CSV-hostile name + plus one
    await ticket(event.id, discount!, "ACTIVE", "Never scanned");
    await ticket(event.id, discount!, "NO_SHOW", "No show");
    await ticket(event.id, discount!, "CANCELLED", "Cancelled");
    const c = await ticket(event.id, odd!, "CHECKED_IN", "Carla");
    await ticket(event.id, free!, "CHECKED_IN", "Free scanned");
    await ticket(event.id, guest!, "CHECKED_IN", "Guest scanned");

    const first = await settleEvent(event.id);
    expect(first.created).toBe(true);
    expect(first.settlement).toMatchObject({ producerId, eventId: event.id, status: "OPEN", currency: "EUR", amountCents: 1200 + 1200 + 838 });
    const lines = await prisma.settlementLine.findMany({ where: { settlementId: first.settlement.id }, orderBy: { owedCents: "desc" } });
    expect(lines.map((l) => [l.ticketId, l.faceValueCents, l.discountPercent, l.owedCents].join(":")).sort()).toEqual(
      [`${a.id}:2000:40:1200`, `${b.id}:2000:40:1200`, `${c.id}:1250:33:838`].sort(),
    );

    const again = await settleEvent(event.id);
    expect(again.created).toBe(false);
    expect(again.settlement.id).toBe(first.settlement.id);
    expect(await prisma.settlement.count({ where: { eventId: event.id } })).toBe(1);

    const { settlement, rows } = await settlementStatement(first.settlement.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.memberName).sort()).toEqual(["=Bruno", "Ana Silva", "Carla"]);
    const csv = statementCsv({ event: settlement.event, timezone: "Europe/Lisbon", rows, amountCents: settlement.amountCents, currency: "EUR" });
    expect(csv.split("\r\n")[0]).toBe("scanned_at,member,plus_one,offer,face_eur,discount_percent,owed_eur");
    expect(csv).toContain("'=Bruno,Zé,Discount,20.00,40,12.00");
    expect(csv).toContain(",Carla,,Odd,12.50,33,8.38");
    expect(csv).toContain(",,,TOTAL,,,32.38");
  });

  it("a ticket scanned at the door after the event finished joins a later settlement run, not an existing one", async () => {
    // Settlement is computed once; what the door scanned by then is what settles (run hourly after FINISHED).
    const { event, offers } = await eventWith([{ name: "Discount", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "10", discountPercent: "50", allocationType: "CAPPED", capacity: 50 }], "PUBLISHED");
    const t1 = await ticket(event.id, offers[0]!.id, "ACTIVE");
    const t2 = await ticket(event.id, offers[0]!.id, "ACTIVE");
    expect((await processScan({ eventId: event.id, code: t1.qrPayload })).result).toBe("OK");
    await expect(settleEvent(event.id)).rejects.toThrow(/Only finished/);
    await setEventStatus(event.id, "FINISHED");
    expect((await processScan({ eventId: event.id, code: t2.qrPayload })).result).toBe("OK");
    const { settlement } = await settleEvent(event.id);
    expect(settlement.amountCents).toBe(1000);
  });

  it("the job settles every finished event once, emails the statement with the CSV attached, and marks nothing-owed events paid", async () => {
    sent.length = 0;
    const paid = await eventWith([{ name: "Discount", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "30", discountPercent: "50", allocationType: "CAPPED", capacity: 50 }]);
    await ticket(paid.event.id, paid.offers[0]!.id, "CHECKED_IN", "Dora");
    const empty = await eventWith([{ name: "Free", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 50 }]);
    await ticket(empty.event.id, empty.offers[0]!.id, "CHECKED_IN");
    const open = await eventWith([{ name: "Discount", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "30", discountPercent: "50", allocationType: "CAPPED", capacity: 50 }], "PUBLISHED");
    await ticket(open.event.id, open.offers[0]!.id, "CHECKED_IN");

    const r = await settleEvents();
    expect(r).toMatchObject({ emailed: 1, nothingOwed: 1 });
    expect(r.settled).toBeGreaterThanOrEqual(2);
    expect(await prisma.settlement.findUnique({ where: { eventId: open.event.id } })).toBeNull();
    expect(await prisma.settlement.findUnique({ where: { eventId: empty.event.id } })).toMatchObject({ amountCents: 0, status: "PAID", reference: NOTHING_OWED });
    const s = await prisma.settlement.findUniqueOrThrow({ where: { eventId: paid.event.id } });
    expect(s).toMatchObject({ amountCents: 1500, status: "OPEN" });
    expect(s.emailedAt).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "money@lux.test", subject: expect.stringMatching(/settlement — Night .* €15\.00/) });
    expect(sent[0]!.attachments).toHaveLength(1);
    const att = sent[0]!.attachments![0]!;
    expect(att.filename).toMatch(/^settlement-\d{4}-\d{2}-\d{2}-night-\d+\.csv$/);
    expect(Buffer.from(att.content, "base64").toString("utf8")).toContain(",Dora,,Discount,30.00,50,15.00");
    expect(sent[0]!.text).toContain("1 discounted ticket scanned");

    // a second run touches nothing
    expect(await settleEvents()).toEqual({ settled: 0, emailed: 0, nothingOwed: 0 });
    expect(sent).toHaveLength(1);

    // mark paid (reference required), reopen, re-send
    await expect(markSettlementPaid(s.id, { reference: "  " })).rejects.toThrow(SettlementError);
    const paidRow = await markSettlementPaid(s.id, { reference: "TRF-2026-001" });
    expect(paidRow).toMatchObject({ status: "PAID", reference: "TRF-2026-001" });
    expect(paidRow.paidAt).not.toBeNull();
    await expect(markSettlementPaid(s.id, { reference: "again" })).rejects.toThrow(/already paid/);
    expect(await sendSettlementEmail(s.id)).toBe(true);
    expect(sent[1]!.text).toContain("Paid — reference TRF-2026-001");
    await reopenSettlement(s.id);
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "OPEN", paidAt: null, reference: null });
    await expect(reopenSettlement((await prisma.settlement.findUniqueOrThrow({ where: { eventId: empty.event.id } })).id)).rejects.toThrow(SettlementError);

    // no contact email → statement can't be sent, settlement still created
    const silent = await createProducer({ name: "No mail", cityId });
    const quiet = await eventWith([{ name: "Discount", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "10", discountPercent: "10", allocationType: "CAPPED", capacity: 50 }], "FINISHED", silent.id);
    await ticket(quiet.event.id, quiet.offers[0]!.id, "CHECKED_IN");
    expect(await settleEvents()).toEqual({ settled: 1, emailed: 0, nothingOwed: 0 });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { eventId: quiet.event.id } })).emailedAt).toBeNull();
  });
});
