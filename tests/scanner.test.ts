import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { addOffer, createEvent, setEventStatus, type OfferInput } from "@/domain/events";
import { createProducer } from "@/domain/producers";
import { issueTicket } from "@/domain/redemption";
import {
  SCANNER_MAX_FAILED_LOGINS,
  ScannerError,
  createScannerToken,
  flagDispute,
  loginScanner,
  processScan,
  scannerSummary,
  searchTickets,
  syncScans,
  ticketManifest,
  verifyScannerToken,
} from "@/domain/scanner";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let producerId: string;

async function publishedEvent(startInHours = 2, offers: OfferInput[] = [{ name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 10 }]) {
  const start = new Date(Date.now() + startInHours * HOUR);
  const end = new Date(start.getTime() + 5 * HOUR);
  const local = (d: Date) => ({ date: d.toISOString().slice(0, 10), time: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` });
  const { event, pin } = await createEvent({ producerId, title: `Night ${start.getTime()}`, startsAt: local(start), endsAt: local(end) });
  const created = [];
  for (const o of offers) created.push(await addOffer(event.id, o));
  await setEventStatus(event.id, "PUBLISHED");
  return { event: await prisma.event.findUniqueOrThrow({ where: { id: event.id } }), offers: created, pin };
}

/** An ACTIVE redemption with its ticket, bypassing keys/eligibility (Phase 5 covers those). */
async function activeTicket(eventId: string, offerId: string, o: { name?: string; plusOne?: string | null; status?: "ACTIVE" | "PENDING_PAYMENT" | "HELD" | "CANCELLED" | "CHECKED_IN"; selfie?: string | null } = {}) {
  const m = await createMember();
  await prisma.member.update({ where: { id: m.id }, data: { name: o.name ?? "Ana Silva", selfieUrl: o.selfie === undefined ? "memory://selfie-ana" : o.selfie } });
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  const r = await prisma.redemption.create({
    data: { memberId: m.id, offerId, eventId, status: o.status ?? "ACTIVE", keyCost: 10, plusOneName: o.plusOne ?? null, cancelDeadlineAt: new Date(event.startsAt.getTime() - DAY), checkedInAt: o.status === "CHECKED_IN" ? new Date() : null },
  });
  const ticket = await issueTicket(prisma, { redemptionId: r.id, memberName: o.name ?? "Ana Silva", photoSnapshotUrl: o.selfie === undefined ? "memory://selfie-ana" : o.selfie, plusOneName: o.plusOne ?? null });
  return { member: m, redemption: r, ticket };
}

describe("scanner", () => {
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    producerId = (await createProducer({ name: "Lux", cityId: s.cityId })).id;
  });

  it("login: code + PIN → signed session; wrong PIN refused; lockout after repeated failures; token verification", async () => {
    const { event, pin } = await publishedEvent();
    await expect(loginScanner({ code: event.scannerCode, pin: "000001" })).rejects.toThrow(/Wrong scanner code or PIN/);
    await expect(loginScanner({ code: "NOPE", pin })).rejects.toThrow(/Wrong scanner code or PIN/);
    const ok = await loginScanner({ code: event.scannerCode.toLowerCase(), pin, device: "Door A" });
    expect(ok.event.id).toBe(event.id);
    const session = verifyScannerToken(ok.token);
    expect(session).toMatchObject({ eventId: event.id, device: "Door A" });
    expect(session!.exp).toBeGreaterThanOrEqual(event.endsAt.getTime() + 12 * HOUR);
    // tampered + expired tokens are rejected
    expect(verifyScannerToken(ok.token.slice(0, -2) + "zz")).toBeNull();
    expect(verifyScannerToken(createScannerToken({ eventId: event.id, device: "x", exp: Date.now() - 1 }))).toBeNull();
    expect(verifyScannerToken(undefined)).toBeNull();

    // lockout: SCANNER_MAX_FAILED_LOGINS wrong PINs lock the code even for the right PIN
    for (let i = 0; i < SCANNER_MAX_FAILED_LOGINS - 1; i++) await expect(loginScanner({ code: event.scannerCode, pin: "999999" })).rejects.toThrow(/Wrong scanner/);
    await expect(loginScanner({ code: event.scannerCode, pin: "999999" })).rejects.toThrow(/locked for 15 minutes/);
    await expect(loginScanner({ code: event.scannerCode, pin })).rejects.toThrow(/locked/);
    const locked = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(locked.scannerLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // after the lock expires the right PIN works again and the counters reset
    const later = new Date(Date.now() + 16 * 60_000);
    await expect(loginScanner({ code: event.scannerCode, pin }, { now: later })).resolves.toMatchObject({ device: "Door" });
    expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ scannerFailedLogins: 0, scannerLockedUntil: null });
  });

  it("OK: checks in once, records the scan with the device, bumps attendance shows, shows photo/+1/offer", async () => {
    const { event, offers } = await publishedEvent();
    const t = await activeTicket(event.id, offers[0]!.id, { plusOne: "Bo" });
    const out = await processScan({ eventId: event.id, code: t.ticket.qrPayload, scannedBy: "Door A" });
    expect(out.result).toBe("OK");
    expect(out.ticket).toMatchObject({ memberName: "Ana Silva", plusOneName: "Bo", photoUrl: "memory://selfie-ana", offerName: "Std", offerType: "FREE_TICKET", status: "CHECKED_IN" });
    expect(out.checkedInAt).toBeTruthy();
    const r = await prisma.redemption.findUniqueOrThrow({ where: { id: t.redemption.id } });
    expect(r.status).toBe("CHECKED_IN");
    expect(r.checkedInAt).not.toBeNull();
    expect(await prisma.scan.findUniqueOrThrow({ where: { id: out.scanId } })).toMatchObject({ result: "OK", ticketId: t.ticket.id, eventId: event.id, scannedBy: "Door A" });
    expect(await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: t.member.id } })).toMatchObject({ shows: 1, noShows: 0 });

    // double scan
    const again = await processScan({ eventId: event.id, code: t.ticket.qrPayload });
    expect(again.result).toBe("ALREADY_SCANNED");
    expect(again.firstScanAt).toBe(r.checkedInAt!.toISOString());
    expect(await prisma.scan.count({ where: { ticketId: t.ticket.id } })).toBe(2);
    expect((await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: t.member.id } })).shows).toBe(1);
  });

  it("two doors scanning the same QR at once: exactly one OK", async () => {
    const { event, offers } = await publishedEvent();
    const t = await activeTicket(event.id, offers[0]!.id);
    const results = await Promise.all(Array.from({ length: 4 }, () => processScan({ eventId: event.id, code: t.ticket.qrPayload })));
    expect(results.filter((r) => r.result === "OK")).toHaveLength(1);
    expect(results.filter((r) => r.result === "ALREADY_SCANNED")).toHaveLength(3);
    expect((await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: t.member.id } })).shows).toBe(1);
    expect(await prisma.scan.count({ where: { ticketId: t.ticket.id } })).toBe(4);
  });

  it("INVALID: unknown code (raw payload kept), tampered signature, wrong event, unpaid, under review — nothing checked in", async () => {
    const { event, offers } = await publishedEvent();
    const other = await publishedEvent(4);

    const unknown = await processScan({ eventId: event.id, code: "deadbeef" });
    expect(unknown).toMatchObject({ result: "INVALID", message: "Not a SIAPP ticket" });
    expect(await prisma.scan.findUniqueOrThrow({ where: { id: unknown.scanId } })).toMatchObject({ ticketId: null, rawPayload: "deadbeef" });

    const tampered = await activeTicket(event.id, offers[0]!.id);
    await prisma.ticket.update({ where: { id: tampered.ticket.id }, data: { signature: "forged" } });
    expect((await processScan({ eventId: event.id, code: tampered.ticket.qrPayload })).result).toBe("INVALID");

    const elsewhere = await activeTicket(other.event.id, other.offers[0]!.id);
    const wrong = await processScan({ eventId: event.id, code: elsewhere.ticket.qrPayload });
    expect(wrong.result).toBe("INVALID");
    expect(wrong.message).toContain("not this event");
    expect(wrong.ticket?.memberName).toBe("Ana Silva");

    const pending = await activeTicket(event.id, offers[0]!.id, { status: "PENDING_PAYMENT" });
    expect(await processScan({ eventId: event.id, code: pending.ticket.qrPayload })).toMatchObject({ result: "INVALID", message: expect.stringMatching(/Not paid/) });
    const held = await activeTicket(event.id, offers[0]!.id, { status: "HELD" });
    expect(await processScan({ eventId: event.id, code: held.ticket.qrPayload })).toMatchObject({ result: "INVALID", message: expect.stringMatching(/Under review/) });

    for (const r of [tampered, elsewhere, pending, held]) {
      expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemption.id } })).status).not.toBe("CHECKED_IN");
    }
    expect(await prisma.attendanceStats.count({ where: { memberId: { in: [tampered, elsewhere, pending, held].map((r) => r.member.id) } } })).toBe(0);
  });

  it("CANCELLED: cancelled / expired / denied / no-show redemptions are refused with the reason", async () => {
    const { event, offers } = await publishedEvent();
    const t = await activeTicket(event.id, offers[0]!.id, { status: "CANCELLED" });
    expect(await processScan({ eventId: event.id, code: t.ticket.qrPayload })).toMatchObject({ result: "CANCELLED", message: "Ticket was cancelled" });
    for (const [status, re] of [["EXPIRED", /never completed/], ["DENIED", /Refused by review/], ["NO_SHOW", /no-show/]] as const) {
      await prisma.redemption.update({ where: { id: t.redemption.id }, data: { status } });
      expect(await processScan({ eventId: event.id, code: t.ticket.qrPayload })).toMatchObject({ result: "CANCELLED", message: expect.stringMatching(re) });
    }
    expect(await prisma.scan.count({ where: { ticketId: t.ticket.id, result: "CANCELLED" } })).toBe(4);
  });

  it("WINDOW_CLOSED: time-window offers after validUntil — REFUSE never admits, PAY_DOOR admits on explicit confirmation", async () => {
    const { event, offers } = await publishedEvent(-1, [
      { name: "Guest list", type: "GUESTLIST", keyCost: 5, allocationType: "TIME_WINDOW", validUntilLocal: "23:30", afterWindowBehaviour: "PAY_DOOR" },
      { name: "Early", type: "GUESTLIST", keyCost: 5, allocationType: "TIME_WINDOW", validUntilLocal: "23:30", afterWindowBehaviour: "REFUSE" },
    ]);
    const [payDoor, refuse] = offers;
    const before = new Date(payDoor!.validUntil!.getTime() - 60_000);
    const after = new Date(payDoor!.validUntil!.getTime() + 60_000);

    const early = await activeTicket(event.id, payDoor!.id);
    expect((await processScan({ eventId: event.id, code: early.ticket.qrPayload }, { now: before })).result).toBe("OK");

    const late = await activeTicket(event.id, payDoor!.id);
    const closed = await processScan({ eventId: event.id, code: late.ticket.qrPayload }, { now: after });
    expect(closed).toMatchObject({ result: "WINDOW_CLOSED", afterWindow: { behaviour: "PAY_DOOR", validUntil: payDoor!.validUntil!.toISOString() }, message: expect.stringMatching(/pays at the door/) });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: late.redemption.id } })).status).toBe("ACTIVE");
    const admitted = await processScan({ eventId: event.id, code: late.ticket.qrPayload, admitAfterWindow: true }, { now: after });
    expect(admitted.result).toBe("OK");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: late.redemption.id } })).status).toBe("CHECKED_IN");

    const refused = await activeTicket(event.id, refuse!.id);
    const r1 = await processScan({ eventId: event.id, code: refused.ticket.qrPayload, admitAfterWindow: true }, { now: after });
    expect(r1).toMatchObject({ result: "WINDOW_CLOSED", afterWindow: { behaviour: "REFUSE" }, message: expect.stringMatching(/refuse entry/) });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: refused.redemption.id } })).status).toBe("ACTIVE");
    expect(await prisma.scan.count({ where: { eventId: event.id, result: "WINDOW_CLOSED" } })).toBe(2);
  });

  it("summary: per-offer redeemed / scanned / remaining, window status and totals", async () => {
    const { event, offers } = await publishedEvent(-1, [
      { name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 5 },
      { name: "Guest list", type: "GUESTLIST", keyCost: 5, allocationType: "TIME_WINDOW", validUntilLocal: "23:30", afterWindowBehaviour: "PAY_DOOR" },
    ]);
    const [capped, window] = offers;
    const a = await activeTicket(event.id, capped!.id);
    await activeTicket(event.id, capped!.id);
    await activeTicket(event.id, capped!.id, { status: "CANCELLED" });
    await activeTicket(event.id, window!.id);
    await processScan({ eventId: event.id, code: a.ticket.qrPayload });
    await processScan({ eventId: event.id, code: "junk" });

    const before = new Date(window!.validUntil!.getTime() - 10 * 60_000);
    const s = (await scannerSummary(event.id, { now: before }))!;
    expect(s.event).toMatchObject({ id: event.id, timezone: "Europe/Lisbon" });
    expect(s.offers[0]).toMatchObject({ name: "Std", redeemed: 2, scanned: 1, capacity: 5, remaining: 3, window: null });
    expect(s.offers[1]).toMatchObject({ name: "Guest list", redeemed: 1, scanned: 0, remaining: null, window: { open: true, minutesLeft: 10, afterWindowBehaviour: "PAY_DOOR" } });
    expect(s.totals).toMatchObject({ redeemed: 3, scanned: 1, scans: 2, disputes: 0 });
    const closed = (await scannerSummary(event.id, { now: new Date(window!.validUntil!.getTime() + 1) }))!;
    expect(closed.offers[1]!.window).toMatchObject({ open: false, minutesLeft: 0 });
    expect(await scannerSummary("nope")).toBeNull();
  });

  it("manual lookup by member name, +1 name or email", async () => {
    const { event, offers } = await publishedEvent();
    const other = await publishedEvent(3);
    const a = await activeTicket(event.id, offers[0]!.id, { name: "Carla Mendes", plusOne: "Zé" });
    await activeTicket(event.id, offers[0]!.id, { name: "Diogo Costa" });
    await activeTicket(other.event.id, other.offers[0]!.id, { name: "Carla Nunes" });
    const byName = await searchTickets(event.id, "carla");
    expect(byName.map((h) => h.memberName)).toEqual(["Carla Mendes"]);
    expect(byName[0]).toMatchObject({ code: a.ticket.qrPayload, plusOneName: "Zé", offerName: "Std", status: "ACTIVE", checkedInAt: null });
    expect((await searchTickets(event.id, "zé")).map((h) => h.memberName)).toEqual(["Carla Mendes"]);
    expect((await searchTickets(event.id, a.member.email)).map((h) => h.ticketId)).toEqual([a.ticket.id]);
    expect(await searchTickets(event.id, "c")).toEqual([]);
    expect((await searchTickets(event.id, "nobody")).length).toBe(0);
  });

  it("dispute: flags the scan with a note and counts once per scan in attendance stats", async () => {
    const { event, offers } = await publishedEvent();
    const other = await publishedEvent(3);
    const t = await activeTicket(event.id, offers[0]!.id);
    const out = await processScan({ eventId: event.id, code: t.ticket.qrPayload });
    await expect(flagDispute({ eventId: event.id, scanId: out.scanId, note: "   " })).rejects.toThrow(ScannerError);
    await expect(flagDispute({ eventId: other.event.id, scanId: out.scanId, note: "x" })).rejects.toThrow(/not found/);
    await flagDispute({ eventId: event.id, scanId: out.scanId, note: "Photo doesn't match" });
    await flagDispute({ eventId: event.id, scanId: out.scanId, note: "Photo doesn't match — brought a friend's phone" });
    expect(await prisma.scan.findUniqueOrThrow({ where: { id: out.scanId } })).toMatchObject({ disputed: true, disputeNote: "Photo doesn't match — brought a friend's phone" });
    expect(await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: t.member.id } })).toMatchObject({ shows: 1, disputes: 1 });
    expect((await scannerSummary(event.id))!.totals.disputes).toBe(1);
  });

  it("offline: manifest lists every ticket with its status; queued scans replay in order with device timestamps", async () => {
    const { event, offers } = await publishedEvent(-1);
    const a = await activeTicket(event.id, offers[0]!.id, { name: "Ana" });
    const b = await activeTicket(event.id, offers[0]!.id, { name: "Bruno", status: "CANCELLED" });
    const manifest = (await ticketManifest(event.id))!;
    expect(manifest.offers[0]).toMatchObject({ id: offers[0]!.id, name: "Std" });
    expect(manifest.tickets).toHaveLength(2);
    expect(manifest.tickets.find((t) => t.code === a.ticket.qrPayload)).toMatchObject({ memberName: "Ana", status: "ACTIVE", offerId: offers[0]!.id, photoUrl: "memory://selfie-ana" });
    expect(manifest.tickets.find((t) => t.code === b.ticket.qrPayload)).toMatchObject({ status: "CANCELLED" });

    const t1 = new Date(Date.now() - 30 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 20 * 60_000).toISOString();
    const synced = await syncScans(
      event.id,
      [
        { code: a.ticket.qrPayload, at: t2 }, // out of order on purpose
        { code: a.ticket.qrPayload, at: t1, disputeNote: "Looked older than the photo" },
        { code: b.ticket.qrPayload, at: t2 },
        { code: "garbage", at: t2 },
      ],
      { scannedBy: "Door B" },
    );
    expect(synced.map((s) => s.outcome.result)).toEqual(["OK", "ALREADY_SCANNED", "CANCELLED", "INVALID"]);
    const r = await prisma.redemption.findUniqueOrThrow({ where: { id: a.redemption.id } });
    expect(r.checkedInAt!.toISOString()).toBe(t1);
    const first = await prisma.scan.findUniqueOrThrow({ where: { id: synced[0]!.outcome.scanId } });
    expect(first).toMatchObject({ result: "OK", scannedBy: "Door B", disputed: true, disputeNote: "Looked older than the photo" });
    expect(first.scannedAt.toISOString()).toBe(t1);
    expect(await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: a.member.id } })).toMatchObject({ shows: 1, disputes: 1 });
    // a timestamp from before the event's plausible range is ignored in favour of the server clock
    const c = await activeTicket(event.id, offers[0]!.id);
    const [old] = await syncScans(event.id, [{ code: c.ticket.qrPayload, at: "2001-01-01T00:00:00.000Z" }]);
    expect(new Date(old!.outcome.checkedInAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await ticketManifest("nope")).toBeNull();
  });
});
