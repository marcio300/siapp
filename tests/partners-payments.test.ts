import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { runSeed } from "../prisma/seed-data";
import { createProducer } from "@/domain/producers";
import { createEvent, addOffer, setEventStatus } from "@/domain/events";
import { redeem } from "@/domain/redemption/redeem";
import { EXTERNAL_HOLD_GRACE_MS, cancelRedemption, expirePendingPayments, startRedemptionPayment } from "@/domain/redemption/lifecycle";
import { RedemptionError } from "@/domain/redemption/errors";
import { verifyQrSignature } from "@/domain/redemption/tickets";
import { getBalance, grantPurchasedKeys } from "@/domain/keys/ledger";
import { getMembership, setBillingStripeForTests, type BillingStripe } from "@/domain/billing";
import { NOTHING_OWED, settleEvent } from "@/domain/settlement";
import { setEmailSinkForTests, type SendEmailInput } from "@/lib/email";
import { makeMemoryStorage, setMediaStorageForTests } from "@/lib/media/storage";
import { applySnapshot, connectProducer, createProducerApiKey, publishPartnerEvent, setOutboundFetchForTests } from "@/domain/partners-api";
import { ExternalOrderError, requestExternalOrder } from "@/domain/partners-api/payments";
import * as paymentRoute from "@/app/api/partner/v1/redemptions/[redemptionId]/payment/route";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EV = "evt_eventos_pay";
const start = new Date(Date.now() + 3 * DAY);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 6 * HOUR);

type Captured = { url: string; headers: Record<string, string>; body: string; envelope: any };
const captured: Captured[] = [];
let respond: (env: any) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }> = () => ({ status: 200, body: { ok: true } });
let failNetwork = false;
const fetchStub: typeof fetch = async (input, init) => {
  if (failNetwork) throw new Error("ECONNREFUSED");
  const body = String(init?.body ?? "");
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const envelope = JSON.parse(body);
  captured.push({ url: String(input), headers, body, envelope });
  const r = await respond(envelope);
  return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const last = (type: string) => [...captured].reverse().find((c) => c.envelope.type === type);
const emails: SendEmailInput[] = [];
const stripeCalls = { sessions: [] as unknown[], refunds: [] as unknown[] };
const fakeStripe = {
  checkout: { sessions: { async create(params: unknown) { stripeCalls.sessions.push(params); return { id: `cs_${stripeCalls.sessions.length}`, url: "https://checkout.stripe.test/s" }; } } },
  refunds: { async create(params: unknown) { stripeCalls.refunds.push(params); return { id: `re_${stripeCalls.refunds.length}` }; } },
  customers: { async create() { return { id: "cus_test" }; } },
  billingPortal: { sessions: { async create() { return { url: "" }; } } },
  subscriptions: { async retrieve() { return {}; }, async update() { return {}; }, async cancel() { return {}; } },
} as unknown as BillingStripe;

let producerId = "";
let producer2Id = "";
let KEY = "";
let KEY2 = "";
let secret = "";
let siappEventId = "";
let discOfferId = "";
let fullOfferId = "";
let manualOfferId = "";

async function readyMember(keys = 100) {
  const m = await createMember();
  await prisma.member.update({ where: { id: m.id }, data: { emailVerified: new Date(), onboardedAt: new Date(), selfieUploadedAt: new Date(), selfieUrl: "memory://selfie", name: "Maria Lopes", createdAt: new Date(Date.now() - 3 * DAY) } });
  await grantPurchasedKeys(m.id, keys, "PACK_PURCHASE");
  // Settle the lazy FREE subscription (and its plan-key grant) so balance deltas are exact.
  await getMembership(m.id);
  return m;
}

function paymentReq(redemptionId: string, body: unknown, opts: { key?: string; idem?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${opts.key ?? KEY}` };
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  return new Request(`http://localhost:3000/api/partner/v1/redemptions/${redemptionId}/payment`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function postPayment(redemptionId: string, body: unknown, opts: { key?: string; idem?: string } = {}) {
  const res = await paymentRoute.POST(paymentReq(redemptionId, body, opts), { params: Promise.resolve({ redemptionId }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

const snapshot = {
  version: 1,
  event: { id: EV, title: "Pay night", status: "PUBLISHED", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "Europe/Lisbon", venue: { name: "Lux" } },
  offers: [
    { ref: `${EV}:tt_std:DISCOUNT`, ticketType: { id: "tt_std", name: "Standard", priceCents: 2000, capacity: 400 }, mode: "DISCOUNT", discountPercent: 40, capacity: 30, openToFree: true, plusOne: { allowed: true, extraCashCents: 1200 } },
    { ref: `${EV}:tt_std:FULL`, ticketType: { id: "tt_std", name: "Standard", priceCents: 2000, capacity: 400 }, mode: "FULL", capacity: 50, openToFree: true },
  ],
};

describe("producer-collects payments (Phase 13)", () => {
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    setMediaStorageForTests(makeMemoryStorage());
    setOutboundFetchForTests(fetchStub);
    setEmailSinkForTests(async (m) => {
      emails.push(m);
    });
    setBillingStripeForTests(fakeStripe);
    producerId = (await createProducer({ name: "Lux Frágil", cityId: s.cityId })).id;
    producer2Id = (await createProducer({ name: "Other club", cityId: s.cityId })).id;
    KEY = (await createProducerApiKey(producerId, null)).plain;
    KEY2 = (await createProducerApiKey(producer2Id, null)).plain;
    const p = await prisma.producer.findUniqueOrThrow({ where: { id: producerId }, include: { city: true } });
    secret = (await connectProducer(p, { eventosOrgId: "org_lux", eventosOrgName: "Lux Lda", webhookUrl: "https://lux.eventos.test/api/webhooks/siapp", appUrl: "https://lux.eventos.test" })).webhookSecret;
    const fresh = await prisma.producer.findUniqueOrThrow({ where: { id: producerId }, include: { city: true } });
    siappEventId = (await applySnapshot(fresh, EV, snapshot)).siappEventId;
    await publishPartnerEvent(producerId, EV);
    const offers = await prisma.offer.findMany({ where: { eventId: siappEventId } });
    discOfferId = offers.find((o) => o.type === "DISCOUNT_TICKET")!.id;
    fullOfferId = offers.find((o) => o.type === "FREE_TICKET")!.id;
    // A hand-managed producer with a discounted offer: the Stripe path must be untouched.
    const manual = await createProducer({ name: "Manual club", cityId: s.cityId });
    const { event } = await createEvent({ producerId: manual.id, title: "Manual night", startsAt: { date: start.toISOString().slice(0, 10), time: "23:00" }, endsAt: { date: new Date(start.getTime() + DAY).toISOString().slice(0, 10), time: "05:00" } });
    const offer = await addOffer(event.id, { name: "Std", type: "DISCOUNT_TICKET", keyCost: 8, faceValueEuros: "20", discountPercent: "40", allocationType: "CAPPED", capacity: 10, openToFree: true } as any);
    manualOfferId = offer.id;
    await setEventStatus(event.id, "PUBLISHED");
  });

  let redemptionId = "";
  let qrPayload = "";
  it("redeem on a producer-collects discount offer → PENDING_PAYMENT with the QR payload minted and no ticket; the window is the partner hold", async () => {
    captured.length = 0;
    const m = await readyMember();
    const before = (await getBalance(m.id)).total;
    const r = await redeem(m.id, discOfferId);
    redemptionId = r.redemptionId;
    expect(r.status).toBe("PENDING_PAYMENT");
    expect(r.cashCents).toBe(1200);
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId }, include: { ticket: true, offer: true } });
    expect(row.offer.paymentMode).toBe("PRODUCER_COLLECTS");
    expect(row.qrPayload).toMatch(/^[0-9a-f]{32}$/);
    qrPayload = row.qrPayload!;
    expect(row.ticket).toBeNull();
    expect(row.paymentExpiresAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await getBalance(m.id)).total).toBe(before - r.keyCost);
    expect(last("redemption.activated")).toBeUndefined();
  });

  it("startRedemptionPayment → signed synchronous order.create with the §4.2 payload; stores order/payUrl/hold; retry reuses the live hold", async () => {
    captured.length = 0;
    const hold = new Date(Date.now() + 15 * 60_000);
    respond = (env) => (env.type === "order.create" ? { status: 200, body: { orderId: "ord_1", totalCents: 1200, payUrl: "https://lux.eventos.test/checkout/ord_1?k=abc", holdExpiresAt: hold.toISOString() } } : { status: 200, body: { ok: true } });
    const r = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId }, include: { member: true } });
    const out = await startRedemptionPayment(redemptionId, r.memberId);
    expect(out).toEqual({ url: "https://lux.eventos.test/checkout/ord_1?k=abc", via: "eventos" });
    const cmd = last("order.create")!;
    expect(cmd.url).toBe("https://lux.eventos.test/api/webhooks/siapp");
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(cmd.headers["x-siapp-signature"])!;
    expect(createHmac("sha256", secret).update(`${sig[1]}.${cmd.body}`).digest("hex")).toBe(sig[2]);
    expect(cmd.envelope).toMatchObject({ type: "order.create", producerId, eventosOrgId: "org_lux" });
    expect(cmd.envelope.data).toMatchObject({
      redemptionId,
      eventosEventId: EV,
      ticketTypeId: "tt_std",
      offerRef: `${EV}:tt_std:DISCOUNT`,
      qrPayload,
      unitPriceCents: 1200,
      faceValueCents: 2000,
      discountPercent: 40,
      plusOne: null,
      expectedTotalCents: 1200,
      buyer: { name: "Maria Lopes", email: r.member.email },
      holdMinutes: 15,
      memberDisplayName: "Maria L.",
    });
    expect(cmd.envelope.data.photoUrl).toContain("/api/partner/v1/tickets/");
    const stored = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } });
    expect(stored).toMatchObject({ externalOrderId: "ord_1", externalPayUrl: "https://lux.eventos.test/checkout/ord_1?k=abc" });
    expect(stored.paymentExpiresAt!.getTime()).toBe(hold.getTime());
    expect(stripeCalls.sessions).toHaveLength(0);
    // Retry from the ticket page: no second command while the hold is live.
    captured.length = 0;
    const again = await startRedemptionPayment(redemptionId, r.memberId);
    expect(again.url).toBe(out.url);
    expect(captured).toHaveLength(0);
    // Nothing was queued through the outbox for this command.
    expect(await prisma.outboundEvent.count({ where: { type: "order.create" as any } })).toBe(0);
  });

  it("price_mismatch (and the other terminal refusals) cancel the redemption and return the keys", async () => {
    captured.length = 0;
    const m = await readyMember(50);
    const before = (await getBalance(m.id)).total;
    const r = await redeem(m.id, discOfferId);
    respond = () => ({ status: 409, body: { error: { code: "price_mismatch", message: "total differs" } } });
    await expect(startRedemptionPayment(r.redemptionId, m.id)).rejects.toMatchObject({ name: "RedemptionError", detail: { code: "price_mismatch" } });
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } });
    expect(row.status).toBe("CANCELLED");
    expect(row.externalOrderId).toBeNull();
    expect((await getBalance(m.id)).total).toBe(before);
    // EventOS never held anything, so no redemption.cancelled is sent (the sales nudge is coalesced per event).
    expect(last("redemption.cancelled")).toBeUndefined();

    // sold_out through the raw helper, for the typed error.
    const m2 = await readyMember(50);
    const r2 = await redeem(m2.id, discOfferId);
    respond = () => ({ status: 409, body: { error: { code: "sold_out", message: "no seats" } } });
    const err = await requestExternalOrder(r2.redemptionId).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalOrderError);
    expect(err).toMatchObject({ code: "sold_out", terminal: true, status: 409 });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r2.redemptionId } })).status).toBe("CANCELLED");
  });

  it("a 5xx or a network error keeps the redemption PENDING_PAYMENT (member can retry)", async () => {
    const m = await readyMember(50);
    const r = await redeem(m.id, discOfferId);
    respond = () => ({ status: 503, body: { error: { code: "internal", message: "down" } } });
    await expect(startRedemptionPayment(r.redemptionId, m.id)).rejects.toMatchObject({ name: "RedemptionError", detail: { code: "unavailable" } });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).status).toBe("PENDING_PAYMENT");
    failNetwork = true;
    await expect(startRedemptionPayment(r.redemptionId, m.id)).rejects.toMatchObject({ detail: { code: "unavailable" } });
    failNetwork = false;
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).status).toBe("PENDING_PAYMENT");
    // Then EventOS accepts.
    respond = () => ({ status: 200, body: { orderId: "ord_retry", payUrl: "https://lux.eventos.test/checkout/ord_retry?k=x", holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } });
    expect((await startRedemptionPayment(r.redemptionId, m.id)).url).toContain("ord_retry");
  });

  it("order.paid → ACTIVE + Ticket with the pre-minted payload, signed, external ids, confirmation email; qr_mismatch 409 changes nothing; replay is a no-op", async () => {
    emails.length = 0;
    captured.length = 0;
    const bad = await postPayment(redemptionId, { kind: "order.paid", orderId: "ord_1", paidAt: new Date().toISOString(), amountCents: 1200, ticket: { id: "tkt_ev_9", qrToken: "0".repeat(32) } });
    expect(bad.status).toBe(409);
    expect(bad.body!.error.code).toBe("qr_mismatch");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId }, include: { ticket: true } })).ticket).toBeNull();

    const paidAt = new Date().toISOString();
    const ok = await postPayment(redemptionId, { kind: "order.paid", orderId: "ord_1", paidAt, amountCents: 1200, ticket: { id: "tkt_ev_9", qrToken: qrPayload } }, { idem: "idem-paid-1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ redemptionStatus: "ACTIVE", outcome: "completed" });
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId }, include: { ticket: true } });
    expect(row.status).toBe("ACTIVE");
    expect(row.paymentExpiresAt).toBeNull();
    expect(row.ticket).toMatchObject({ qrPayload, externalTicketId: "tkt_ev_9", externalOrderId: "ord_1", memberName: "Maria Lopes" });
    expect(verifyQrSignature(row.ticket!.qrPayload, row.ticket!.signature)).toBe(true);
    expect(ok.body!.ticketId).toBe(row.ticket!.id);
    expect(emails.some((e) => e.subject.startsWith("you're in"))).toBe(true);
    // No redemption.activated loop: EventOS already has the ticket (sales.updated is coalesced per event).
    expect(last("redemption.activated")).toBeUndefined();

    // Idempotent replay (same key) and a bare repeat (different key) both leave one ticket.
    const replay = await postPayment(redemptionId, { kind: "order.paid", orderId: "ord_1", paidAt, amountCents: 1200, ticket: { id: "tkt_ev_9", qrToken: qrPayload } }, { idem: "idem-paid-1" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    // Same key with a different body is refused (contract §1).
    const mismatch = await postPayment(redemptionId, { kind: "order.paid", orderId: "ord_1", paidAt, amountCents: 1300, ticket: { id: "tkt_ev_9", qrToken: qrPayload } }, { idem: "idem-paid-1" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body!.error.code).toBe("idempotency_mismatch");
    const repeat = await postPayment(redemptionId, { kind: "order.paid", orderId: "ord_1", ticket: { id: "tkt_ev_9", qrToken: qrPayload } });
    expect(repeat.body).toMatchObject({ redemptionStatus: "ACTIVE", outcome: "noop", ticketId: row.ticket!.id });
    expect(await prisma.ticket.count({ where: { redemptionId } })).toBe(1);
  });

  it("another producer's key is refused; unknown redemption 404; bad body 422", async () => {
    const forbidden = await postPayment(redemptionId, { kind: "order.expired", orderId: "ord_1" }, { key: KEY2 });
    expect(forbidden.status).toBe(403);
    expect((await postPayment("nope", { kind: "order.expired", orderId: "ord_1" })).status).toBe(404);
    const invalid = await postPayment(redemptionId, { kind: "order.bogus" });
    expect(invalid.status).toBe(422);
  });

  it("order.expired → EXPIRED + keys back (only while PENDING_PAYMENT); the local sweep waits a grace period for EventOS holds", async () => {
    const m = await readyMember(50);
    const before = (await getBalance(m.id)).total;
    const r = await redeem(m.id, discOfferId);
    const hold = new Date(Date.now() + 15 * 60_000);
    respond = () => ({ status: 200, body: { orderId: "ord_exp", payUrl: "https://lux.eventos.test/checkout/ord_exp?k=x", holdExpiresAt: hold.toISOString() } });
    await startRedemptionPayment(r.redemptionId, m.id);
    // Our sweep: not yet at the hold, nor inside the grace after it.
    expect((await expirePendingPayments({ now: new Date(hold.getTime() + 1000) })).expired).toBe(0);
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).status).toBe("PENDING_PAYMENT");
    // EventOS says the hold lapsed.
    const out = await postPayment(r.redemptionId, { kind: "order.expired", orderId: "ord_exp" });
    expect(out.body).toMatchObject({ redemptionStatus: "EXPIRED", outcome: "expired" });
    expect((await getBalance(m.id)).total).toBe(before);
    expect((await postPayment(r.redemptionId, { kind: "order.expired", orderId: "ord_exp" })).body).toMatchObject({ outcome: "noop" });
    // A late order.paid after expiry is a no-op (no ticket).
    const late = await postPayment(r.redemptionId, { kind: "order.paid", orderId: "ord_exp", ticket: { id: "tkt_late", qrToken: "x" } });
    expect(late.body).toMatchObject({ redemptionStatus: "EXPIRED", outcome: "noop" });
    expect(await prisma.ticket.count({ where: { redemptionId: r.redemptionId } })).toBe(0);

    // Straggler: EventOS never reported; our sweep expires it after the grace and tells EventOS.
    const m2 = await readyMember(50);
    const r2 = await redeem(m2.id, discOfferId);
    await startRedemptionPayment(r2.redemptionId, m2.id);
    captured.length = 0;
    expect((await expirePendingPayments({ now: new Date(hold.getTime() + EXTERNAL_HOLD_GRACE_MS + 1000) })).expired).toBeGreaterThanOrEqual(1);
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: r2.redemptionId } })).status).toBe("EXPIRED");
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId: r2.redemptionId, reason: "expired", refundCash: false });
  });

  it("cancelling an ACTIVE paid redemption refunds keys, calls no Stripe, and tells EventOS to refund the cash; a pending one releases the hold", async () => {
    captured.length = 0;
    stripeCalls.refunds.length = 0;
    const r = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } });
    const before = (await getBalance(r.memberId)).total;
    const out = await cancelRedemption(redemptionId, r.memberId);
    expect(out).toEqual({ keysRefunded: r.keyCost, cashRefundedCents: 1200 });
    expect(stripeCalls.refunds).toHaveLength(0);
    expect((await getBalance(r.memberId)).total).toBe(before + r.keyCost);
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId, reason: "member", refundCash: true });

    const m = await readyMember(50);
    const pending = await redeem(m.id, discOfferId);
    respond = () => ({ status: 200, body: { orderId: "ord_pend", payUrl: "https://lux.eventos.test/checkout/ord_pend?k=x", holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } });
    await startRedemptionPayment(pending.redemptionId, m.id);
    captured.length = 0;
    await cancelRedemption(pending.redemptionId, m.id);
    expect(last("redemption.cancelled")!.envelope.data).toMatchObject({ redemptionId: pending.redemptionId, reason: "member", refundCash: false });
  });

  it("refund.succeeded / refund.failed are recorded on the redemption", async () => {
    const failed = await postPayment(redemptionId, { kind: "refund.failed", orderId: "ord_1", refundId: "ref_1", amountCents: 1200, error: "card_expired" });
    expect(failed.body).toMatchObject({ outcome: "recorded" });
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } })).externalRefundError).toBe("card_expired");
    const ok = await postPayment(redemptionId, { kind: "refund.succeeded", orderId: "ord_1", refundId: "ref_2", amountCents: 1200 });
    expect(ok.body).toMatchObject({ outcome: "recorded" });
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } });
    expect(row.externalRefundedAt).toBeTruthy();
    expect(row.externalRefundError).toBeNull();
  });

  it("settlement skips producer-collects offers: a finished EventOS event with scanned discounted tickets owes nothing", async () => {
    // Pay + scan one discounted ticket, then finish the event.
    const m = await readyMember(50);
    const r = await redeem(m.id, discOfferId);
    const paid = await postPayment(r.redemptionId, { kind: "order.paid", orderId: "ord_set", ticket: { id: "tkt_set", qrToken: (await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } })).qrPayload! } });
    expect(paid.body!.outcome).toBe("completed");
    await prisma.redemption.update({ where: { id: r.redemptionId }, data: { status: "CHECKED_IN", checkedInAt: new Date() } });
    await prisma.event.update({ where: { id: siappEventId }, data: { status: "FINISHED" } });
    const { settlement } = await settleEvent(siappEventId);
    expect(settlement).toMatchObject({ amountCents: 0, status: "PAID", reference: NOTHING_OWED });
    expect(await prisma.settlementLine.count({ where: { settlementId: settlement.id } })).toBe(0);
    await prisma.event.update({ where: { id: siappEventId }, data: { status: "PUBLISHED" } });
  });

  it("SIAPP_COLLECTS stays on Stripe: a hand-managed discounted offer opens Checkout and mints no QR payload up front", async () => {
    captured.length = 0;
    const m = await readyMember(50);
    const r = await redeem(m.id, manualOfferId);
    expect(r.status).toBe("PENDING_PAYMENT");
    const row = await prisma.redemption.findUniqueOrThrow({ where: { id: r.redemptionId } });
    expect(row.qrPayload).toBeNull();
    expect(row.paymentExpiresAt!.getTime() - Date.now()).toBeLessThan(11 * 60_000);
    const out = await startRedemptionPayment(r.redemptionId, m.id);
    expect(out.via).toBe("stripe");
    expect(stripeCalls.sessions).toHaveLength(1);
    expect(captured).toHaveLength(0);
    // The payment endpoint refuses to complete a Stripe redemption for a producer it doesn't belong to.
    expect((await postPayment(r.redemptionId, { kind: "order.paid", orderId: "x", ticket: { id: "t", qrToken: "q" } })).status).toBe(403);
    // Full-redemption EventOS offers are untouched by the dispatcher (ACTIVE at once).
    const m2 = await readyMember(50);
    expect((await redeem(m2.id, fullOfferId)).status).toBe("ACTIVE");
    await expect(startRedemptionPayment(r.redemptionId, "someone-else")).rejects.toBeInstanceOf(RedemptionError);
  });
});
