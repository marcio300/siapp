import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { runSeed } from "../prisma/seed-data";
import { createProducer } from "@/domain/producers";
import { redeem } from "@/domain/redemption/redeem";
import { cancelRedemption, denyHeldRedemption, expirePendingPayments, markNoShows, refundEventRedemptions } from "@/domain/redemption/lifecycle";
import { issueTicket } from "@/domain/redemption/tickets";
import { processScan } from "@/domain/scanner/scan";
import { grantPurchasedKeys, spendKeys } from "@/domain/keys/ledger";
import { makeMemoryStorage, setMediaStorageForTests } from "@/lib/media/storage";
import {
  OUTBOUND_BACKOFF_MS,
  applySnapshot,
  connectProducer,
  createProducerApiKey,
  disconnectProducer,
  flushOutbound,
  notifyRedemptionActivated,
  publishPartnerEvent,
  queueOutbound,
  queueSalesUpdated,
  recordExternalCheckIn,
  retryOutbound,
  setOutboundFetchForTests,
  signEnvelope,
  signatureHeader,
  ulid,
  verifyApiKey,
  verifyPhotoSignature,
  webhookSecrets,
} from "@/domain/partners-api";
import * as checkinRoute from "@/app/api/partner/v1/redemptions/[redemptionId]/checkin/route";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EV = "evt_eventos_out";
const EV2 = "evt_eventos_cancel";
const start = new Date(Date.now() + 3 * DAY);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 6 * HOUR);

type Captured = { url: string; headers: Record<string, string>; body: string; envelope: any };
const captured: Captured[] = [];
let respond: (env: any) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }> = () => ({ status: 200, body: { ok: true } });
const fetchStub: typeof fetch = async (input, init) => {
  const body = String(init?.body ?? "");
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const envelope = JSON.parse(body);
  captured.push({ url: String(input), headers, body, envelope });
  const r = await respond(envelope);
  return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const last = (type: string) => [...captured].reverse().find((c) => c.envelope.type === type);

let producerId = "";
let producer2Id = "";
let KEY = "";
let KEY2 = "";
let secret = "";
let siappEventId = "";
let siappEvent2Id = "";
let fullOfferId = "";
let glOfferId = "";
let discOfferId = "";

async function readyMember(keys = 100) {
  const m = await createMember();
  await prisma.member.update({ where: { id: m.id }, data: { emailVerified: new Date(), onboardedAt: new Date(), selfieUploadedAt: new Date(), selfieUrl: "memory://selfie", name: "Maria Lopes", createdAt: new Date(Date.now() - 3 * DAY) } });
  await grantPurchasedKeys(m.id, keys, "PACK_PURCHASE");
  return m;
}

/** An ACTIVE redemption + ticket on an offer, bypassing eligibility. */
async function activeRedemption(offerId: string, eventId: string, extra: Partial<{ status: "ACTIVE" | "HELD" | "PENDING_PAYMENT"; cashCents: number; paymentExpiresAt: Date }> = {}) {
  const m = await readyMember(50);
  const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
  const r = await prisma.redemption.create({ data: { memberId: m.id, offerId, eventId, status: extra.status ?? "ACTIVE", keyCost: offer.keyCost, cashCents: extra.cashCents ?? 0, paymentExpiresAt: extra.paymentExpiresAt ?? null, cancelDeadlineAt: new Date(start.getTime() - DAY) } });
  await spendKeys(m.id, offer.keyCost, r.id);
  if ((extra.status ?? "ACTIVE") === "ACTIVE") await issueTicket(prisma, { redemptionId: r.id, memberName: "Maria Lopes", photoSnapshotUrl: "memory://selfie", plusOneName: null });
  return r;
}

function snapshot(eventosEventId: string, version: number) {
  return {
    version,
    event: { id: eventosEventId, title: `Night ${eventosEventId}`, status: "PUBLISHED", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "Europe/Lisbon", venue: { name: "Lux" } },
    offers: [
      { ref: `${eventosEventId}:tt_std:FULL`, ticketType: { id: "tt_std", name: "Standard", priceCents: 1500, capacity: 400 }, mode: "FULL", capacity: 50, openToFree: true, maxPerMember: 2 },
      { ref: `${eventosEventId}:tt_std:DISCOUNT`, ticketType: { id: "tt_std", name: "Standard", priceCents: 2000, capacity: 400 }, mode: "DISCOUNT", discountPercent: 40, capacity: 30, openToFree: true },
      { ref: `${eventosEventId}:tt_gl:GUESTLIST`, ticketType: { id: "tt_gl", name: "Guest list", priceCents: 0, capacity: null }, mode: "GUESTLIST", window: { untilLocalTime: "02:00", afterWindow: "PAY_DOOR" }, openToFree: true },
    ],
  };
}

describe("partner outbound + external check-ins (Phase 12)", () => {
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    setMediaStorageForTests(makeMemoryStorage());
    setOutboundFetchForTests(fetchStub);
    producerId = (await createProducer({ name: "Lux Frágil", cityId: s.cityId })).id;
    producer2Id = (await createProducer({ name: "Other club", cityId: s.cityId })).id;
    KEY = (await createProducerApiKey(producerId, null)).plain;
    KEY2 = (await createProducerApiKey(producer2Id, null)).plain;
    const p = await prisma.producer.findUniqueOrThrow({ where: { id: producerId }, include: { city: true } });
    const connected = await connectProducer(p, { eventosOrgId: "org_lux", eventosOrgName: "Lux Lda", webhookUrl: "https://lux.eventos.test/api/webhooks/siapp", appUrl: "https://lux.eventos.test" });
    secret = connected.webhookSecret;
    const fresh = await prisma.producer.findUniqueOrThrow({ where: { id: producerId }, include: { city: true } });
    const snap = await applySnapshot(fresh, EV, snapshot(EV, 1));
    siappEventId = snap.siappEventId;
    await publishPartnerEvent(producerId, EV);
    const snap2 = await applySnapshot(fresh, EV2, snapshot(EV2, 1));
    siappEvent2Id = snap2.siappEventId;
    await publishPartnerEvent(producerId, EV2);
    const offers = await prisma.offer.findMany({ where: { eventId: siappEventId } });
    fullOfferId = offers.find((o) => o.type === "FREE_TICKET")!.id;
    glOfferId = offers.find((o) => o.type === "GUESTLIST")!.id;
    discOfferId = offers.find((o) => o.type === "DISCOUNT_TICKET")!.id;
  });

  it("signature: contract §1.2 test vector + header shape; ULIDs are 26 chars and sort by time", () => {
    const body = '{"id":"01JC6K3Z6V2Q4R8T9X0YB1C2D3","type":"ping","producerId":"prod_123","createdAt":"2024-11-07T17:20:00Z","data":{}}';
    expect(signEnvelope("whsec_test", 1731000000, body)).toBe("8e383532506a0cbb70c61e2ce8cd5e7f30b60b2836cea59013d936d29a719fcd");
    expect(signatureHeader("whsec_test", body, new Date(1731000000 * 1000))).toBe("t=1731000000,v1=8e383532506a0cbb70c61e2ce8cd5e7f30b60b2836cea59013d936d29a719fcd");
    const a = ulid(new Date(1_000_000));
    const b = ulid(new Date(2_000_000));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  let fullRedemptionId = "";
  it("FULL redemption → signed redemption.activated with photo url + sales.updated; reply ids stored", async () => {
    respond = (env) => (env.type === "redemption.activated" ? { status: 200, body: { ok: true, ticketId: "tkt_ev_1", orderId: "ord_ev_1" } } : { status: 200, body: { ok: true } });
    captured.length = 0;
    const m = await readyMember();
    const r = await redeem(m.id, fullOfferId);
    fullRedemptionId = r.redemptionId;
    expect(r.status).toBe("ACTIVE");
    const act = last("redemption.activated")!;
    expect(act).toBeTruthy();
    expect(act.url).toBe("https://lux.eventos.test/api/webhooks/siapp");
    // Signature verifies against the webhook secret over "t.body".
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(act.headers["x-siapp-signature"])!;
    expect(createHmac("sha256", secret).update(`${sig[1]}.${act.body}`).digest("hex")).toBe(sig[2]);
    expect(act.envelope).toMatchObject({ type: "redemption.activated", producerId, eventosOrgId: "org_lux" });
    expect(act.envelope.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(act.headers["x-request-id"]).toBe(act.envelope.id);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { redemptionId: r.redemptionId } });
    expect(act.envelope.data).toMatchObject({ redemptionId: r.redemptionId, siappEventId, eventosEventId: EV, offerRef: `${EV}:tt_std:FULL`, ticketTypeId: "tt_std", qrPayload: ticket.qrPayload, member: { displayName: "Maria L." }, plusOneName: null, keyCost: 15, window: null });
    expect(act.envelope.data.member.email).toBeUndefined();
    const photo = new URL(act.envelope.data.photoUrl);
    expect(photo.pathname).toBe(`/api/partner/v1/tickets/${ticket.id}/photo`);
    expect(verifyPhotoSignature([secret], ticket.id, Number(photo.searchParams.get("exp")), photo.searchParams.get("sig")!)).toBe("ok");
    expect(new Date(act.envelope.data.photoExpiresAt).getTime()).toBe(end.getTime() + 24 * HOUR);
    // Reply stored on the row + the ticket.
    expect(ticket.externalTicketId).toBe("tkt_ev_1");
    expect(ticket.externalOrderId).toBe("ord_ev_1");
    const row = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: act.envelope.id } });
    expect(row).toMatchObject({ status: "SENT", attempts: 1, responseStatus: 200, eventId: siappEventId });
    expect(last("sales.updated")!.envelope.data).toEqual({ siappEventId, eventosEventId: EV });
  });

  it("GUESTLIST carries the window; DISCOUNT never produces redemption.activated", async () => {
    captured.length = 0;
    const m = await readyMember();
    const r = await redeem(m.id, glOfferId);
    expect(r.status).toBe("ACTIVE");
    const act = last("redemption.activated")!;
    expect(act.envelope.data.window).toMatchObject({ afterWindow: "PAY_DOOR" });
    expect(new Date(act.envelope.data.window.validUntil).getTime()).toBeGreaterThan(start.getTime());
    expect(act.envelope.data.keyCost).toBe(10);

    captured.length = 0;
    const disc = await activeRedemption(discOfferId, siappEventId, { cashCents: 1200 });
    expect(await notifyRedemptionActivated(disc.id)).toBeNull();
    expect(captured.filter((c) => c.envelope.type === "redemption.activated")).toHaveLength(0);
    expect(await prisma.outboundEvent.count({ where: { type: "redemption.activated", payload: { path: ["redemptionId"], equals: disc.id } } })).toBe(0);
  });

  it("retry/backoff: 503 → 1 m → 5 m, network error retries, 404 is terminal, staff retry re-arms", async () => {
    const p = await prisma.producer.findUniqueOrThrow({ where: { id: producerId } });
    const t0 = new Date();
    const row = (await queueOutbound(p, "ticket.checked_in", { redemptionId: "x" }, { now: t0 }))!;
    respond = () => ({ status: 503, body: { error: "down" } });
    let rep = await flushOutbound({ now: t0, ids: [row.id] });
    expect(rep).toEqual({ sent: 0, retried: 1, failed: 0 });
    let fresh = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh).toMatchObject({ status: "PENDING", attempts: 1, responseStatus: 503 });
    expect(fresh.nextAttemptAt.getTime()).toBe(t0.getTime() + OUTBOUND_BACKOFF_MS[0]);
    expect(fresh.lastError).toContain("HTTP 503");
    // Not due yet.
    expect(await flushOutbound({ now: new Date(t0.getTime() + 30_000), ids: [row.id] })).toEqual({ sent: 0, retried: 0, failed: 0 });
    const t1 = new Date(t0.getTime() + 61_000);
    respond = () => { throw new Error("ECONNRESET"); };
    rep = await flushOutbound({ now: t1, ids: [row.id] });
    expect(rep.retried).toBe(1);
    fresh = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh.attempts).toBe(2);
    expect(fresh.nextAttemptAt.getTime()).toBe(t1.getTime() + OUTBOUND_BACKOFF_MS[1]);
    expect(fresh.lastError).toBe("ECONNRESET");
    const t2 = new Date(fresh.nextAttemptAt.getTime() + 1);
    respond = () => ({ status: 404, body: { error: { code: "not_found" } } });
    rep = await flushOutbound({ now: t2, ids: [row.id] });
    expect(rep.failed).toBe(1);
    fresh = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh).toMatchObject({ status: "FAILED", attempts: 3, responseStatus: 404 });
    expect(await retryOutbound(row.id, { now: t2 })).toBe(true);
    respond = () => ({ status: 200, body: { ok: true } });
    expect(await flushOutbound({ now: t2, ids: [row.id] })).toEqual({ sent: 1, retried: 0, failed: 0 });
    fresh = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh).toMatchObject({ status: "SENT", attempts: 1, lastError: null });
    expect(fresh.sentAt).not.toBeNull();
    // Six retryable failures → FAILED.
    const row2 = (await queueOutbound(p, "ticket.checked_in", { redemptionId: "y" }, { now: t0 }))!;
    respond = () => ({ status: 500 });
    let t = t0;
    for (let i = 0; i < OUTBOUND_BACKOFF_MS.length; i++) {
      await flushOutbound({ now: t, ids: [row2.id] });
      t = new Date(t.getTime() + OUTBOUND_BACKOFF_MS[i]! + 1);
    }
    expect((await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row2.id } })).status).toBe("PENDING");
    await flushOutbound({ now: t, ids: [row2.id] });
    expect((await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row2.id } })).status).toBe("FAILED");
    respond = () => ({ status: 200, body: { ok: true } });
  });

  it("sales.updated coalesces to one pending row per event, next one waits 30 s after a send", async () => {
    const t0 = new Date(Date.now() + 10 * 60_000); // past every pending backoff so the flush isolates this row
    await prisma.outboundEvent.deleteMany({ where: { dedupeKey: `sales:${siappEvent2Id}` } });
    const a = await queueSalesUpdated(siappEvent2Id, { now: t0 });
    const b = await queueSalesUpdated(siappEvent2Id, { now: t0 });
    const c = await queueSalesUpdated(siappEvent2Id, { now: t0 });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(c).toBeNull();
    expect(await prisma.outboundEvent.count({ where: { dedupeKey: `sales:${siappEvent2Id}` } })).toBe(1);
    await flushOutbound({ now: t0, ids: [a!] });
    const sent = await prisma.outboundEvent.findUniqueOrThrow({ where: { dedupeKey: `sales:${siappEvent2Id}` } });
    expect(sent.status).toBe("SENT");
    const t1 = new Date(t0.getTime() + 5_000);
    const d = await queueSalesUpdated(siappEvent2Id, { now: t1 });
    expect(d).toBeTruthy();
    const rearmed = await prisma.outboundEvent.findUniqueOrThrow({ where: { dedupeKey: `sales:${siappEvent2Id}` } });
    expect(rearmed.status).toBe("PENDING");
    expect(rearmed.nextAttemptAt.getTime()).toBe(t0.getTime() + 30_000);
    expect(await flushOutbound({ now: t1, ids: [d!] })).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect((await flushOutbound({ now: new Date(t0.getTime() + 31_000), ids: [d!] })).sent).toBe(1);
  });

  it("cancellations: member / staff / denied / expired / event_cancelled with refundCash", async () => {
    const offers = await prisma.offer.findMany({ where: { eventId: siappEvent2Id } });
    const full2 = offers.find((o) => o.type === "FREE_TICKET")!.id;
    const disc2 = offers.find((o) => o.type === "DISCOUNT_TICKET")!.id;
    const byMember = await activeRedemption(full2, siappEvent2Id);
    captured.length = 0;
    await cancelRedemption(byMember.id, byMember.memberId);
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId: byMember.id, reason: "member", refundCash: false });
    expect(typeof last("redemption.cancelled")!.envelope.data.cancelledAt).toBe("string");

    const byStaff = await activeRedemption(full2, siappEvent2Id);
    captured.length = 0;
    await cancelRedemption(byStaff.id, null, { reason: "staff" });
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ reason: "staff", refundCash: false });

    const held = await activeRedemption(full2, siappEvent2Id, { status: "HELD" });
    captured.length = 0;
    expect(await denyHeldRedemption(held.id)).toBe(true);
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId: held.id, reason: "denied", refundCash: false });

    const pending = await activeRedemption(disc2, siappEvent2Id, { status: "PENDING_PAYMENT", cashCents: 1200, paymentExpiresAt: new Date(Date.now() - 60_000) });
    captured.length = 0;
    expect((await expirePendingPayments()).expired).toBe(1);
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId: pending.id, reason: "expired", refundCash: false });

    const paid = await activeRedemption(disc2, siappEvent2Id, { cashCents: 1200 });
    const free = await activeRedemption(full2, siappEvent2Id);
    captured.length = 0;
    expect((await refundEventRedemptions(siappEvent2Id)).refunded).toBe(2);
    const cancelled = captured.filter((c) => c.envelope.type === "redemption.cancelled").map((c) => c.envelope.data);
    expect(cancelled).toHaveLength(2);
    expect(cancelled.find((d) => d.redemptionId === paid.id)).toMatchObject({ reason: "event_cancelled", refundCash: true });
    expect(cancelled.find((d) => d.redemptionId === free.id)).toMatchObject({ reason: "event_cancelled", refundCash: false });
  });

  it("our scanner's OK on an EventOS event → ticket.checked_in", async () => {
    const r = await activeRedemption(fullOfferId, siappEventId);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { redemptionId: r.id } });
    captured.length = 0;
    const out = await processScan({ eventId: siappEventId, code: ticket.qrPayload, scannedBy: "door-1" });
    expect(out.result).toBe("OK");
    const msg = last("ticket.checked_in")!;
    expect(msg.envelope.data).toMatchObject({ redemptionId: r.id, qrPayload: ticket.qrPayload, gate: "door-1", siappScanId: out.scanId });
    expect(typeof msg.envelope.data.at).toBe("string");
    const scan = await prisma.scan.findUniqueOrThrow({ where: { id: out.scanId } });
    expect(scan.source).toBe("SIAPP");
  });

  const route = checkinRoute.POST as unknown as (req: Request, ctx: { params: Promise<{ redemptionId: string }> }) => Promise<Response>;
  async function checkin(redemptionId: string, body: unknown, key = KEY) {
    const res = await route(new Request(`http://localhost:3000/api/partner/v1/redemptions/${redemptionId}/checkin`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ redemptionId }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it("external check-in: OK → CHECKED_IN + Scan(EVENTOS) + shows; replay; ALREADY_SCANNED; 403; cancelled; validation", async () => {
    const at = new Date().toISOString();
    const ok = await checkin(fullRedemptionId, { at, gate: "Main door", eventosCheckInId: "chk_1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ result: "OK", redemptionStatus: "CHECKED_IN" });
    expect(ok.body.replay).toBeUndefined();
    const r = await prisma.redemption.findUniqueOrThrow({ where: { id: fullRedemptionId } });
    expect(r.status).toBe("CHECKED_IN");
    expect(r.checkedInAt).not.toBeNull();
    const scan = await prisma.scan.findUniqueOrThrow({ where: { externalId: "chk_1" } });
    expect(scan).toMatchObject({ source: "EVENTOS", scannedBy: "eventos:Main door", result: "OK", eventId: siappEventId });
    expect((await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: r.memberId } })).shows).toBe(1);
    // Same EventOS check-in id → same answer, nothing new recorded.
    const replay = await checkin(fullRedemptionId, { at, gate: "Main door", eventosCheckInId: "chk_1" });
    expect(replay.body).toMatchObject({ result: "OK", replay: true });
    expect(await prisma.scan.count({ where: { ticket: { redemptionId: fullRedemptionId } } })).toBe(1);
    // A second door scanning the same ticket.
    const dup = await checkin(fullRedemptionId, { at, gate: "Side door", eventosCheckInId: "chk_2" });
    expect(dup.body).toMatchObject({ result: "ALREADY_SCANNED", redemptionStatus: "CHECKED_IN" });
    expect(dup.body.firstScanAt).toBe(r.checkedInAt!.toISOString());
    expect((await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: r.memberId } })).shows).toBe(1);
    // Another producer's key.
    const forbidden = await checkin(fullRedemptionId, { at, eventosCheckInId: "chk_3" }, KEY2);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("forbidden");
    expect((await checkin("nope", { at, eventosCheckInId: "chk_4" })).status).toBe(404);
    const invalid = await checkin(fullRedemptionId, { gate: "x" });
    expect(invalid.status).toBe(422);
    // Cancelled redemption.
    const c = await activeRedemption(fullOfferId, siappEventId);
    await cancelRedemption(c.id, null);
    const cancelled = await checkin(c.id, { at, eventosCheckInId: "chk_5" });
    expect(cancelled.body).toMatchObject({ result: "CANCELLED", redemptionStatus: "CANCELLED" });
    // Pending redemption → INVALID.
    const pend = await activeRedemption(discOfferId, siappEventId, { status: "PENDING_PAYMENT", cashCents: 1200, paymentExpiresAt: new Date(Date.now() + HOUR) });
    expect((await checkin(pend.id, { at, eventosCheckInId: "chk_6" })).body.result).toBe("INVALID");
  });

  it("markNoShows waits the grace period for EventOS events; no-show reversal within 48 h", async () => {
    const noShowCandidate = await activeRedemption(glOfferId, siappEventId);
    const lateOne = await activeRedemption(glOfferId, siappEventId);
    // A hand-managed event that ended at the same time finishes right away.
    const manual = await prisma.event.create({ data: { producerId: producer2Id, cityId: (await prisma.producer.findUniqueOrThrow({ where: { id: producer2Id } })).cityId, title: "Manual", startsAt: start, endsAt: end, status: "PUBLISHED", scannerCode: "MANUAL", scannerPinHash: "x" } });
    const r1 = await markNoShows({ now: new Date(end.getTime() + HOUR) });
    expect(r1.finishedEvents).toBe(1);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("FINISHED");
    expect((await prisma.event.findUniqueOrThrow({ where: { id: siappEventId } })).status).toBe("PUBLISHED");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: noShowCandidate.id } })).status).toBe("ACTIVE");
    captured.length = 0;
    const r2 = await markNoShows({ now: new Date(end.getTime() + 7 * HOUR) });
    expect(r2.finishedEvents).toBe(2); // both EventOS events, now past the grace
    expect((await prisma.event.findUniqueOrThrow({ where: { id: siappEventId } })).status).toBe("FINISHED");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: noShowCandidate.id } })).status).toBe("NO_SHOW");
    // The counters nudge is coalesced: a row for this event is live (PENDING within the 30 s window, or already SENT).
    const nudge = await prisma.outboundEvent.findUniqueOrThrow({ where: { dedupeKey: `sales:${siappEventId}` } });
    expect(["PENDING", "SENT"]).toContain(nudge.status);
    const statsBefore = await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: noShowCandidate.memberId } });
    expect(statsBefore.noShows).toBe(1);

    // The producer's offline scanner syncs 8 h after the end → reversal.
    const rev = await recordExternalCheckIn(producerId, noShowCandidate.id, { at: new Date(end.getTime() - HOUR).toISOString(), gate: "Late sync", eventosCheckInId: "chk_late_1" }, { now: new Date(end.getTime() + 8 * HOUR) });
    expect(rev).toMatchObject({ result: "OK", redemptionStatus: "CHECKED_IN", reversedNoShow: true });
    const fixed = await prisma.redemption.findUniqueOrThrow({ where: { id: noShowCandidate.id } });
    expect(fixed.status).toBe("CHECKED_IN");
    expect(fixed.checkedInAt!.getTime()).toBe(end.getTime() - HOUR);
    const statsAfter = await prisma.attendanceStats.findUniqueOrThrow({ where: { memberId: noShowCandidate.memberId } });
    expect(statsAfter).toMatchObject({ noShows: 0, shows: 1 });
    expect((await prisma.scan.findUniqueOrThrow({ where: { externalId: "chk_late_1" } })).scannedBy).toBe("eventos:Late sync");
    // 49 h later it is too late.
    const tooLate = await recordExternalCheckIn(producerId, lateOne.id, { at: end.toISOString(), eventosCheckInId: "chk_late_2" }, { now: new Date(end.getTime() + 49 * HOUR) });
    expect(tooLate).toMatchObject({ result: "CANCELLED", redemptionStatus: "NO_SHOW" });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: lateOne.id } })).status).toBe("NO_SHOW");
  });

  it("disconnect: producer.disconnected is delivered before the key dies / the binding is forgotten", async () => {
    captured.length = 0;
    await disconnectProducer(producerId, "key_revoked");
    expect(last("producer.disconnected")!.envelope.data).toEqual({ reason: "key_revoked" });
    expect(await verifyApiKey(KEY)).toEqual({ ok: false, code: "producer_revoked" });
    expect((await prisma.producer.findUniqueOrThrow({ where: { id: producerId } })).eventosOrgId).toBe("org_lux");
    captured.length = 0;
    await disconnectProducer(producerId, "staff");
    expect(last("producer.disconnected")!.envelope.data).toEqual({ reason: "staff" });
    const p = await prisma.producer.findUniqueOrThrow({ where: { id: producerId } });
    expect(p.eventosOrgId).toBeNull();
    expect(webhookSecrets(p)).toEqual([]);
    // Nothing can be queued for a producer that isn't connected.
    expect(await queueOutbound(p, "sales.updated", {})).toBeNull();
    setOutboundFetchForTests(null);
    setMediaStorageForTests(null);
  });
});
