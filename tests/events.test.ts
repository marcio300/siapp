import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { decryptText } from "@/lib/media/crypto";
import { localToUtc } from "@/lib/time";
import { ProducerError, clearPayoutDetails, createProducer, payoutDetails, updateProducer } from "@/domain/producers";
import {
  EventError,
  addOffer,
  authenticateScanner,
  createEvent,
  deleteOffer,
  duplicateEvent,
  offerCounters,
  regenerateScannerPin,
  setEventStatus,
  updateEvent,
  updateOffer,
  verifyPin,
  type OfferInput,
} from "@/domain/events";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const LISBON = "Europe/Lisbon";
const HOUR = 3_600_000;

describe("producers & events", () => {
  let cityId: string;
  let producerId: string;
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    cityId = s.cityId;
  });

  it("producer CRUD with encrypted payout details", async () => {
    await expect(createProducer({ name: "X", cityId })).rejects.toBeInstanceOf(ProducerError);
    await expect(createProducer({ name: "Lux", cityId, contactEmail: "nope" })).rejects.toThrow(/contact email/);
    const p = await createProducer({ name: "Lux Frágil", cityId, contactEmail: "Door@LUX.pt", payoutDetails: "PT50 0002 0123 1234 5678 9015 4", defaultDiscountPercent: "40", usesEventOS: true });
    producerId = p.id;
    expect(p.contactEmail).toBe("door@lux.pt");
    expect(p.payoutDetailsEncrypted).not.toContain("PT50");
    expect(decryptText(p.payoutDetailsEncrypted!)).toBe("PT50 0002 0123 1234 5678 9015 4");
    expect(payoutDetails(p.payoutDetailsEncrypted, false)).toEqual({ masked: "••••••••••••0154", full: null });
    expect(payoutDetails(p.payoutDetailsEncrypted, true).full).toBe("PT50 0002 0123 1234 5678 9015 4");
    // Empty payout on update keeps the stored value; explicit clear removes it.
    const u = await updateProducer(p.id, { name: "Lux Frágil", cityId, payoutDetails: "", usesEventOS: true });
    expect(u.payoutDetailsEncrypted).toBe(p.payoutDetailsEncrypted);
    expect((await clearPayoutDetails(p.id)).payoutDetailsEncrypted).toBeNull();
    expect(p.defaultDiscountPercent).toBe(40);
  });

  const eventInput = (over: Partial<Parameters<typeof createEvent>[0]> = {}) => ({
    producerId,
    title: "Saturday at Lux",
    imageUrls: "https://img.example/a.jpg\nhttps://img.example/b.jpg",
    tags: "techno, Club, techno",
    startsAt: { date: "2026-07-18", time: "23:00" },
    endsAt: { date: "2026-07-19", time: "06:00" },
    ...over,
  });

  it("creates an event in the producer's city with UTC dates, a scanner code and a one-time PIN", async () => {
    const { event, pin } = await createEvent(eventInput());
    expect(event.cityId).toBe(cityId);
    expect(event.status).toBe("DRAFT");
    expect(event.startsAt.toISOString()).toBe("2026-07-18T22:00:00.000Z"); // 23:00 WEST
    expect(event.endsAt.toISOString()).toBe("2026-07-19T05:00:00.000Z");
    expect(event.tags).toEqual(["techno", "club"]);
    expect(event.imageUrls).toHaveLength(2);
    expect(event.scannerCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(pin).toMatch(/^\d{6}$/);
    expect(verifyPin(pin, event.scannerPinHash)).toBe(true);
    expect(verifyPin("000000", event.scannerPinHash)).toBe(pin === "000000");
    expect(await authenticateScanner(event.scannerCode.toLowerCase(), pin)).toMatchObject({ id: event.id });
    expect(await authenticateScanner(event.scannerCode, "999999")).toBeNull();
    const newPin = await regenerateScannerPin(event.id);
    expect(await authenticateScanner(event.scannerCode, pin)).toBeNull();
    expect(await authenticateScanner(event.scannerCode, newPin)).not.toBeNull();

    await expect(createEvent(eventInput({ endsAt: { date: "2026-07-18", time: "22:00" } }))).rejects.toThrow(/end after/);
    await expect(createEvent(eventInput({ imageUrls: "ftp://x" }))).rejects.toThrow(/http/);
    await expect(createEvent(eventInput({ title: "" }))).rejects.toBeInstanceOf(EventError);
  });

  it("offers: validation per type/allocation, time window stored as absolute UTC next day, +1 and private sale", async () => {
    const { event } = await createEvent(eventInput());
    const base: OfferInput = { name: "Early", type: "FREE_TICKET", keyCost: 25, allocationType: "CAPPED", capacity: 300 };
    await expect(addOffer(event.id, { ...base, capacity: "" })).rejects.toThrow(/capacity/);
    await expect(addOffer(event.id, { ...base, type: "DISCOUNT_TICKET" })).rejects.toThrow(/face value/);
    await expect(addOffer(event.id, { ...base, allocationType: "TIME_WINDOW" })).rejects.toThrow(/until time/);
    await expect(addOffer(event.id, { ...base, privateSaleTiers: ["PLUS"] })).rejects.toThrow(/24 or 48/);
    await expect(addOffer(event.id, { ...base, privateSaleTiers: ["PLUS"], privateSaleHoursBefore: "36" })).rejects.toThrow(/24 or 48/);

    const early = await addOffer(event.id, { ...base, privateSaleTiers: ["PLUS"], privateSaleHoursBefore: "48", plusOneAllowed: true, plusOneExtraKeyCost: "5", plusOneExtraCashEuros: "3.50", maxPerMember: "2" });
    expect(early).toMatchObject({ capacity: 300, privateSaleTiers: ["PLUS"], privateSaleHoursBefore: 48, privateSaleOpensAt: null, plusOneExtraKeyCost: 5, plusOneExtraCashCents: 350, maxPerMember: 2, faceValueCents: null });

    const standard = await addOffer(event.id, { name: "Standard", type: "DISCOUNT_TICKET", keyCost: 10, faceValueEuros: "20", discountPercent: "40", allocationType: "TIME_WINDOW", validUntilLocal: "02:00", afterWindowBehaviour: "PAY_DOOR", openToFree: true });
    expect(standard).toMatchObject({ faceValueCents: 2000, discountPercent: 40, capacity: null, afterWindowBehaviour: "PAY_DOOR", openToFree: true });
    expect(standard.validUntil!.toISOString()).toBe("2026-07-19T01:00:00.000Z"); // 02:00 WEST on the 19th

    // Explicit private-sale opens-at (local) wins over the computed one.
    const vip = await addOffer(event.id, { ...base, name: "VIP", privateSaleTiers: ["PLUS", "REGULAR"], privateSaleOpensAt: { date: "2026-07-10", time: "18:00" } });
    expect(vip.privateSaleOpensAt!.toISOString()).toBe("2026-07-10T17:00:00.000Z");
    expect(vip.privateSaleHoursBefore).toBeNull();
  });

  it("publishing computes privateSaleOpensAt = publishedAt + hoursBefore, only once, and respects explicit values", async () => {
    const { event } = await createEvent(eventInput());
    await expect(setEventStatus(event.id, "PUBLISHED")).rejects.toThrow(/at least one offer/);
    const base: OfferInput = { name: "Early", type: "FREE_TICKET", keyCost: 25, allocationType: "CAPPED", capacity: 300 };
    const a = await addOffer(event.id, { ...base, privateSaleTiers: ["PLUS"], privateSaleHoursBefore: "48" });
    const b = await addOffer(event.id, { ...base, name: "B", privateSaleTiers: ["PLUS"], privateSaleHoursBefore: "24", privateSaleOpensAt: { date: "2026-07-01", time: "12:00" } });
    const c = await addOffer(event.id, { ...base, name: "C" });
    const publishedAt = new Date("2026-07-10T10:00:00Z");
    const published = await setEventStatus(event.id, "PUBLISHED", { now: publishedAt });
    expect(published.publishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: a.id } })).privateSaleOpensAt?.toISOString()).toBe("2026-07-12T10:00:00.000Z");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: b.id } })).privateSaleOpensAt?.toISOString()).toBe("2026-07-01T11:00:00.000Z");
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: c.id } })).privateSaleOpensAt).toBeNull();

    // An offer added after publishing gets its opens-at immediately.
    const d = await addOffer(event.id, { ...base, name: "D", privateSaleTiers: ["SOCIAL"], privateSaleHoursBefore: "24" });
    expect(d.privateSaleOpensAt?.toISOString()).toBe("2026-07-11T10:00:00.000Z");

    // Unpublish + republish keeps the original publishedAt (and opens-at).
    await setEventStatus(event.id, "DRAFT");
    const again = await setEventStatus(event.id, "PUBLISHED", { now: new Date("2026-07-11T10:00:00Z") });
    expect(again.publishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: a.id } })).privateSaleOpensAt?.toISOString()).toBe("2026-07-12T10:00:00.000Z");

    await expect(setEventStatus(event.id, "PUBLISHED")).rejects.toThrow(/Can't go/);
    await setEventStatus(event.id, "FINISHED");
    await expect(setEventStatus(event.id, "DRAFT")).rejects.toBeInstanceOf(EventError);
    await expect(updateEvent(event.id, eventInput())).rejects.toThrow(/finished/);
    await expect(addOffer(event.id, base)).rejects.toThrow(/finished/);
  });

  it("counters, frozen economics after redemptions, delete guard, duplicate with shifted dates", async () => {
    const { event } = await createEvent(eventInput());
    const offer = await addOffer(event.id, { name: "Std", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 50 });
    const m1 = await createMember();
    const m2 = await createMember();
    const mk = (memberId: string, status: "ACTIVE" | "CHECKED_IN" | "CANCELLED") =>
      prisma.redemption.create({ data: { memberId, offerId: offer.id, eventId: event.id, status, keyCost: 10, cancelDeadlineAt: new Date(event.startsAt.getTime() - 24 * HOUR) } });
    await mk(m1.id, "ACTIVE");
    await mk(m2.id, "CHECKED_IN");
    await mk(m2.id, "CANCELLED");
    expect((await offerCounters([offer.id])).get(offer.id)).toEqual({ redeemed: 2, checkedIn: 1 });

    const edit: OfferInput = { name: "Std renamed", type: "FREE_TICKET", keyCost: 10, allocationType: "CAPPED", capacity: 80 };
    expect((await updateOffer(offer.id, edit)).capacity).toBe(80);
    await expect(updateOffer(offer.id, { ...edit, keyCost: 12 })).rejects.toThrow(/can't change after/);
    await expect(updateOffer(offer.id, { ...edit, capacity: "1" })).rejects.toThrow(/below the 2/);
    await expect(deleteOffer(offer.id)).rejects.toThrow(/redemptions/);
    const spare = await addOffer(event.id, { name: "Spare", type: "GUESTLIST", keyCost: 5, allocationType: "TIME_WINDOW", validUntilLocal: "01:00", afterWindowBehaviour: "REFUSE" });
    await deleteOffer(spare.id);
    expect(await prisma.offer.count({ where: { eventId: event.id } })).toBe(1);

    const { event: copy, pin } = await duplicateEvent(event.id, { shiftDays: 7 });
    expect(copy.title).toBe("Saturday at Lux (copy)");
    expect(copy.status).toBe("DRAFT");
    expect(copy.scannerCode).not.toBe(event.scannerCode);
    expect(verifyPin(pin, copy.scannerPinHash)).toBe(true);
    expect(copy.startsAt.getTime()).toBe(event.startsAt.getTime() + 7 * 86_400_000);
    const copiedOffers = await prisma.offer.findMany({ where: { eventId: copy.id } });
    expect(copiedOffers).toHaveLength(1);
    expect(copiedOffers[0]).toMatchObject({ name: "Std renamed", capacity: 80, keyCost: 10 });
    expect(await prisma.redemption.count({ where: { eventId: copy.id } })).toBe(0);
    expect((await offerCounters([copiedOffers[0]!.id])).get(copiedOffers[0]!.id)).toEqual({ redeemed: 0, checkedIn: 0 });
    expect(localToUtc({ date: "2026-07-25", time: "23:00" }, LISBON).getTime()).toBe(copy.startsAt.getTime());
  });
});
