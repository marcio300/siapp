import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { createProducer } from "@/domain/producers";
import { EventError, updateOffer } from "@/domain/events";
import { checkEligibility } from "@/domain/redemption";
import { grantPurchasedKeys, spendKeys } from "@/domain/keys/ledger";
import { makeMemoryStorage, setMediaStorageForTests } from "@/lib/media/storage";
import {
  API_KEY_RE,
  checkRateLimit,
  computeKeyCost,
  createProducerApiKey,
  generateApiKey,
  hashApiKey,
  memberPriceCents,
  photoSignature,
  resetRateLimitForTests,
  revokeProducerApiKeys,
  setOfferKeyCostOverride,
  signedPhotoUrl,
  verifyApiKey,
  verifyPhotoSignature,
  webhookSecrets,
  type Pricing,
} from "@/domain/partners-api";
import * as connectRoute from "@/app/api/partner/v1/connect/route";
import * as pricingRoute from "@/app/api/partner/v1/pricing/route";
import * as eventRoute from "@/app/api/partner/v1/events/[eventosEventId]/route";
import * as publishRoute from "@/app/api/partner/v1/events/[eventosEventId]/publish/route";
import * as pauseRoute from "@/app/api/partner/v1/events/[eventosEventId]/pause/route";
import * as cancelRoute from "@/app/api/partner/v1/events/[eventosEventId]/cancel/route";
import * as salesRoute from "@/app/api/partner/v1/events/[eventosEventId]/sales/route";
import * as settlementRoute from "@/app/api/partner/v1/events/[eventosEventId]/settlement/route";
import * as photoRoute from "@/app/api/partner/v1/tickets/[ticketId]/photo/route";
import { prisma, resetDatabase } from "./db";
import { createMember, createStaff } from "./fixtures";

const DAY = 86_400_000;
const PRICING: Pricing = { keyValueCents: 100, minKeyCost: 2, guestlistKeyCost: 10, keyCostOverridePct: 0, minDiscountPercent: 10, maxDiscountPercent: 99 };

type RouteCtx = { params: Promise<{ eventosEventId: string }> };
type Handler = (req: Request, ctx: RouteCtx) => Promise<Response>;

function req(method: string, path: string, opts: { key?: string | null; body?: unknown; idem?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? KEY}`;
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  return new Request(`http://localhost:3000${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (eventosEventId: string): RouteCtx => ({ params: Promise.resolve({ eventosEventId }) });
async function call(handler: Handler, method: string, path: string, eventosEventId: string, opts: Parameters<typeof req>[2] = {}) {
  const res = await handler(req(method, path, opts), ctx(eventosEventId));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

let KEY = "";
let producerId = "";
let cityId = "";
const EV = "evt_eventos_1";
const start = new Date(Date.now() + 3 * DAY);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 6 * 3_600_000);

function snapshot(version: number, offers: unknown[], over: Record<string, unknown> = {}) {
  return {
    version,
    event: { id: EV, title: "Friday at Lux", status: "PUBLISHED", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: "Europe/Lisbon", venue: { name: "Lux", address: "Av. Infante D. Henrique" }, imageUrls: ["https://img.example/a.jpg"], tags: ["Techno", "club"], ...over },
    offers,
  };
}
const fullOffer = (cap = 50) => ({ ref: `${EV}:tt_std:FULL`, ticketType: { id: "tt_std", name: "Standard", priceCents: 1500, capacity: 400 }, mode: "FULL", capacity: cap, plusOne: { allowed: true }, openToFree: false, maxPerMember: 1 });
const discountOffer = (d = 40, cap = 30) => ({ ref: `${EV}:tt_std:DISCOUNT`, ticketType: { id: "tt_std", name: "Standard", priceCents: 2000, capacity: 400 }, mode: "DISCOUNT", discountPercent: d, capacity: cap, plusOne: { allowed: true, extraCashCents: 1200 }, privateSale: { tiers: ["PLUS"], hoursBefore: 48 } });
const guestlist = () => ({ ref: `${EV}:tt_gl:GUESTLIST`, ticketType: { id: "tt_gl", name: "Guest list", priceCents: 0, capacity: null }, mode: "GUESTLIST", window: { untilLocalTime: "02:00", afterWindow: "PAY_DOOR" } });

describe("partner API (EventOS)", () => {
  beforeAll(async () => {
    await resetDatabase();
    const s = await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    cityId = s.cityId;
    const p = await createProducer({ name: "Lux Frágil", cityId, contactEmail: "door@lux.pt" });
    producerId = p.id;
    resetRateLimitForTests();
  });

  it("keys: format, verify, revoke-on-regenerate, lastUsedAt", async () => {
    const k = generateApiKey();
    expect(k.plain).toMatch(API_KEY_RE);
    expect(k.hash).toBe(hashApiKey(k.plain));
    const staff = await createStaff("ADMIN");
    const first = await createProducerApiKey(producerId, staff.id);
    const v1 = await verifyApiKey(first.plain);
    expect(v1.ok && v1.producer.id).toBe(producerId);
    expect(await verifyApiKey("siapp_pk_nope")).toEqual({ ok: false, code: "unauthorized" });
    expect(await verifyApiKey(`siapp_pk_${"A".repeat(8)}_${"B".repeat(32)}`)).toEqual({ ok: false, code: "unauthorized" });
    const second = await createProducerApiKey(producerId, staff.id);
    expect(await verifyApiKey(first.plain)).toEqual({ ok: false, code: "producer_revoked" });
    const v2 = await verifyApiKey(second.plain);
    expect(v2.ok).toBe(true);
    const row = await prisma.producerApiKey.findUniqueOrThrow({ where: { keyHash: second.row.keyHash } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(await revokeProducerApiKeys(producerId)).toBe(1);
    expect(await verifyApiKey(second.plain)).toEqual({ ok: false, code: "producer_revoked" });
    KEY = (await createProducerApiKey(producerId, staff.id)).plain;
  });

  it("pricing rule: €15 → 15, 40 % of €20 → 8, floor 2, guest list 10, override wins", () => {
    expect(computeKeyCost({ mode: "FULL", priceCents: 1500 }, PRICING)).toBe(15);
    expect(computeKeyCost({ mode: "DISCOUNT", priceCents: 2000, discountPercent: 40 }, PRICING)).toBe(8);
    expect(computeKeyCost({ mode: "FULL", priceCents: 100 }, PRICING)).toBe(2);
    expect(computeKeyCost({ mode: "DISCOUNT", priceCents: 1500, discountPercent: 20 }, PRICING)).toBe(3);
    expect(computeKeyCost({ mode: "GUESTLIST", priceCents: 0 }, PRICING)).toBe(10);
    expect(computeKeyCost({ mode: "FULL", priceCents: 1500, override: 5 }, PRICING)).toBe(5);
    expect(memberPriceCents(2000, 40)).toBe(1200);
  });

  it("rate limit: fixed window per key", () => {
    const now = new Date("2026-11-09T10:00:10Z");
    expect(checkRateLimit("k", 2, now)).toEqual({ ok: true });
    expect(checkRateLimit("k", 2, now)).toEqual({ ok: true });
    expect(checkRateLimit("k", 2, now)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(checkRateLimit("k", 2, new Date("2026-11-09T10:01:00Z"))).toEqual({ ok: true });
  });

  it("auth: missing/invalid key → 401; revoked → producer_revoked", async () => {
    expect((await call(pricingRoute.GET as Handler, "GET", "/api/partner/v1/pricing", "", { key: null })).status).toBe(401);
    const bad = await call(pricingRoute.GET as Handler, "GET", "/api/partner/v1/pricing", "", { key: `siapp_pk_${"A".repeat(8)}_${"B".repeat(32)}` });
    expect(bad.status).toBe(401);
    expect(bad.body?.error.code).toBe("unauthorized");
    const ok = await call(pricingRoute.GET as Handler, "GET", "/api/partner/v1/pricing", "");
    expect(ok.status).toBe(200);
    expect(ok.body?.pricing).toEqual(PRICING);
    expect(ok.body?.limits.maxOffersPerEvent).toBe(10);
    expect(ok.headers.get("x-request-id")).toBeTruthy();
  });

  it("connect: binds the org, rotates the secret, refuses a different org", async () => {
    const r1 = await call(connectRoute.POST as Handler, "POST", "/api/partner/v1/connect", "", { body: { eventosOrgId: "org_1", eventosOrgName: "Lux Lda", webhookUrl: "https://lux.eventos.app/api/webhooks/siapp", appUrl: "https://lux.eventos.app" } });
    expect(r1.status).toBe(200);
    expect(r1.body?.contract).toBe("2026-11-08");
    expect(r1.body?.producer.city.timezone).toBe("Europe/Lisbon");
    expect(r1.body?.pricing.keyValueCents).toBe(100);
    expect(r1.body?.webhookSecret).toMatch(/^whsec_/);
    const p1 = await prisma.producer.findUniqueOrThrow({ where: { id: producerId } });
    expect(p1.eventosOrgId).toBe("org_1");
    expect(p1.usesEventOS).toBe(true);
    expect(webhookSecrets(p1)).toEqual([r1.body!.webhookSecret]);

    const other = await call(connectRoute.POST as Handler, "POST", "/api/partner/v1/connect", "", { body: { eventosOrgId: "org_2", webhookUrl: "https://x.example/hook" } });
    expect(other.status).toBe(409);
    expect(other.body?.error.code).toBe("producer_bound");

    const r2 = await call(connectRoute.POST as Handler, "POST", "/api/partner/v1/connect", "", { body: { eventosOrgId: "org_1", webhookUrl: "https://lux.eventos.app/api/webhooks/siapp" } });
    expect(r2.status).toBe(200);
    expect(r2.body?.webhookSecret).not.toBe(r1.body?.webhookSecret);
    const p2 = await prisma.producer.findUniqueOrThrow({ where: { id: producerId } });
    expect(webhookSecrets(p2)).toEqual([r2.body!.webhookSecret, r1.body!.webhookSecret]); // previous valid 24 h
    expect(webhookSecrets(p2, new Date(Date.now() + 25 * 3_600_000))).toEqual([r2.body!.webhookSecret]);
    const bad = await call(connectRoute.POST as Handler, "POST", "/api/partner/v1/connect", "", { body: { eventosOrgId: "org_1", webhookUrl: "not a url" } });
    expect(bad.status).toBe(422);
    expect(bad.body?.error.details[0].field).toBe("webhookUrl");
  });

  it("snapshot validation codes (422 applies nothing)", async () => {
    const path = `/api/partner/v1/events/${EV}`;
    const codes = async (offers: unknown[], over: Record<string, unknown> = {}) => {
      const r = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(1, offers, over) });
      expect(r.status).toBe(422);
      return (r.body?.error.details as { code: string; ref?: string }[]).map((d) => d.code);
    };
    expect(await codes([discountOffer(5)])).toContain("discount_out_of_range");
    expect(await codes([discountOffer(100)])).toContain("discount_out_of_range");
    expect(await codes([{ ...discountOffer(), ticketType: { id: "tt_std", name: "Standard", priceCents: 0 } }])).toContain("face_value_required");
    expect(await codes([{ ...fullOffer(), capacity: null }])).toContain("capacity_required");
    expect(await codes([fullOffer(401)])).toContain("capacity_exceeds_type");
    expect(await codes([{ ...guestlist(), window: null }])).toContain("window_required");
    expect(await codes([{ ...fullOffer(), ref: "evt_other:tt_std:FULL" }])).toContain("ref_invalid");
    expect(await codes([fullOffer(), fullOffer()])).toContain("duplicate_ref");
    expect(await codes([fullOffer()], { endsAt: new Date(start.getTime() - 1000).toISOString() })).toContain("ends_before_starts");
    expect(await codes([fullOffer()], { startsAt: new Date(Date.now() - 2 * DAY).toISOString(), endsAt: new Date(Date.now() - DAY).toISOString() })).toContain("event_in_past");
    const many = Array.from({ length: 11 }, (_, i) => ({ ...fullOffer(), ref: `${EV}:tt${i}:FULL`, ticketType: { id: `tt${i}`, name: `T${i}`, priceCents: 1000 } }));
    expect(await codes(many)).toContain("too_many_offers");
    const zod = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: { version: 1, event: { id: EV, title: "x", startsAt: "nope" }, offers: [] } });
    expect(zod.status).toBe(422);
    expect(zod.body?.error.code).toBe("validation_failed");
    expect(await prisma.event.count({ where: { producerId } })).toBe(0);
  });

  let siappEventId = "";
  it("snapshot upsert: event + offers from the pricing rule, idempotency, version guard", async () => {
    const path = `/api/partner/v1/events/${EV}`;
    const body = snapshot(3, [fullOffer(), discountOffer(), guestlist()], { endsAt: undefined });
    const r = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body, idem: "01JIDEMP1" });
    expect(r.status).toBe(200);
    siappEventId = r.body!.siappEventId;
    expect(r.body?.status).toBe("DRAFT");
    expect(r.body?.version).toBe(3);
    expect(r.body?.warnings.map((w: { code: string }) => w.code)).toContain("ends_at_defaulted");
    const byRef = Object.fromEntries((r.body!.offers as any[]).map((o) => [o.ref, o]));
    expect(byRef[`${EV}:tt_std:FULL`]).toMatchObject({ type: "FREE_TICKET", keyCost: 15, memberPriceCents: null, paymentMode: "PRODUCER_COLLECTS", frozen: false, capacity: 50 });
    expect(byRef[`${EV}:tt_std:DISCOUNT`]).toMatchObject({ type: "DISCOUNT_TICKET", keyCost: 8, memberPriceCents: 1200, discountPercent: 40 });
    expect(byRef[`${EV}:tt_gl:GUESTLIST`]).toMatchObject({ type: "GUESTLIST", keyCost: 10, capacity: null });

    const ev = await prisma.event.findUniqueOrThrow({ where: { id: siappEventId }, include: { offers: { orderBy: { sortOrder: "asc" } } } });
    expect(ev.source).toBe("EVENTOS");
    expect(ev.externalId).toBe(EV);
    expect(ev.cityId).toBe(cityId);
    expect(ev.endsAt.getTime()).toBe(start.getTime() + 6 * 3_600_000);
    expect(ev.tags).toEqual(["techno", "club"]);
    expect(ev.scannerCode).toHaveLength(6);
    const gl = ev.offers.find((o) => o.type === "GUESTLIST")!;
    expect(gl.allocationType).toBe("TIME_WINDOW");
    expect(gl.validUntil!.getTime()).toBeGreaterThan(start.getTime());
    expect(gl.afterWindowBehaviour).toBe("PAY_DOOR");
    const full = ev.offers.find((o) => o.type === "FREE_TICKET")!;
    expect(full.plusOneAllowed).toBe(true);
    expect(full.plusOneExtraKeyCost).toBe(15);
    expect(full.faceValueCents).toBe(1500);
    const disc = ev.offers.find((o) => o.type === "DISCOUNT_TICKET")!;
    expect(disc.privateSaleTiers).toEqual(["PLUS"]);
    expect(disc.privateSaleHoursBefore).toBe(48);
    expect(disc.plusOneExtraCashCents).toBe(1200);

    // Idempotency: same key + same body → replay; same key + other body → 422.
    const replay = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body, idem: "01JIDEMP1" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body).toEqual(r.body);
    const mismatch = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(4, [fullOffer()]), idem: "01JIDEMP1" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body?.error.code).toBe("idempotency_mismatch");

    // Version guard + re-apply.
    const stale = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(2, [fullOffer()]) });
    expect(stale.status).toBe(409);
    expect(stale.body?.error.code).toBe("stale_version");
    const same = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(3, [fullOffer(), discountOffer(), guestlist()]) });
    expect(same.status).toBe(200);
    expect(await prisma.offer.count({ where: { eventId: siappEventId } })).toBe(3);
  });

  it("publish / pause / cancel mirror + paused eligibility + member listing filter", async () => {
    // A second, offer-less event can't publish.
    const emptyId = "evt_eventos_empty";
    const e = await call(eventRoute.PUT as Handler, "PUT", `/api/partner/v1/events/${emptyId}`, emptyId, { body: { ...snapshot(1, []), event: { ...snapshot(1, []).event, id: emptyId } } });
    expect(e.status).toBe(200);
    const noOffers = await call(publishRoute.POST as Handler, "POST", `/api/partner/v1/events/${emptyId}/publish`, emptyId);
    expect(noOffers.status).toBe(422);
    expect(noOffers.body?.error.code).toBe("no_offers");
    expect((await call(publishRoute.POST as Handler, "POST", "/api/partner/v1/events/nope/publish", "nope")).status).toBe(404);

    const pub = await call(publishRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/publish`, EV);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ siappEventId, status: "PUBLISHED", pausedAt: null });
    const disc = await prisma.offer.findFirstOrThrow({ where: { eventId: siappEventId, type: "DISCOUNT_TICKET" }, include: { event: true } });
    expect(disc.privateSaleOpensAt).not.toBeNull(); // computed on publish

    const paused = await call(pauseRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/pause`, EV);
    expect(paused.status).toBe(200);
    expect(paused.body?.status).toBe("PUBLISHED");
    expect(paused.body?.pausedAt).toBeTruthy();
    const ev = await prisma.event.findUniqueOrThrow({ where: { id: siappEventId } });
    const member = { id: "m", emailVerified: new Date(), onboardedAt: new Date(), selfieUploadedAt: new Date(), bannedAt: null };
    const full = await prisma.offer.findFirstOrThrow({ where: { eventId: siappEventId, type: "FREE_TICKET" } });
    const refused = checkEligibility({ now: new Date(), member, tierCode: "REGULAR", isPaid: true, balanceTotal: 100, offer: { ...full, event: ev }, used: 0, reservedForOthers: 0, ownCount: 0, plusOne: false });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe("EVENT_PAUSED");
    // The member listing's where-clause hides paused events.
    expect(await prisma.event.count({ where: { status: "PUBLISHED", pausedAt: null, id: siappEventId } })).toBe(0);

    const again = await call(publishRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/publish`, EV);
    expect(again.body?.pausedAt).toBeNull();
    const allowed = checkEligibility({ now: new Date(), member, tierCode: "REGULAR", isPaid: true, balanceTotal: 100, offer: { ...full, event: { ...ev, pausedAt: null } }, used: 0, reservedForOthers: 0, ownCount: 0, plusOne: false });
    expect(allowed.ok).toBe(true);
  });

  let redemptionId = "";
  it("frozen fields + deletion rule after a live redemption; capacity may grow; key cost sticks", async () => {
    const m = await createMember();
    const full = await prisma.offer.findFirstOrThrow({ where: { eventId: siappEventId, type: "FREE_TICKET" } });
    await grantPurchasedKeys(m.id, 50, "PACK_PURCHASE");
    const r = await prisma.redemption.create({ data: { memberId: m.id, offerId: full.id, eventId: siappEventId, status: "ACTIVE", keyCost: full.keyCost, cancelDeadlineAt: new Date(start.getTime() - DAY) } });
    redemptionId = r.id;
    await spendKeys(m.id, full.keyCost, r.id);
    await prisma.ticket.create({ data: { redemptionId: r.id, qrPayload: "a".repeat(32), signature: "sig", memberName: "Maria Lopes" } });

    const path = `/api/partner/v1/events/${EV}`;
    const frozen = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(5, [{ ...fullOffer(), ticketType: { id: "tt_std", name: "Standard", priceCents: 1800, capacity: 400 } }, discountOffer(), guestlist()]) });
    expect(frozen.status).toBe(422);
    expect(frozen.body?.error.details[0]).toMatchObject({ ref: `${EV}:tt_std:FULL`, code: "offer_frozen" });
    const below = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(5, [fullOffer(0), discountOffer(), guestlist()]) });
    expect(below.status).toBe(422); // capacity 0 fails zod min(1) → invalid
    const removed = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(5, [discountOffer(), guestlist()]) });
    expect(removed.status).toBe(422);
    expect(removed.body?.error.details.map((d: { code: string }) => d.code)).toContain("offer_has_redemptions");

    // Pricing changes don't touch a live offer's key cost; capacity grows; the unused guest list can be removed.
    await prisma.setting.update({ where: { key: "key_value_cents" }, data: { value: 50 } });
    const grow = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(6, [fullOffer(80), discountOffer()]) });
    expect(grow.status).toBe(200);
    const byRef = Object.fromEntries((grow.body!.offers as any[]).map((o) => [o.ref, o]));
    expect(byRef[`${EV}:tt_std:FULL`]).toMatchObject({ keyCost: 15, capacity: 80, frozen: true, counters: { active: 1 } });
    expect(byRef[`${EV}:tt_std:DISCOUNT`].keyCost).toBe(16); // 800 / 50
    expect(await prisma.offer.count({ where: { eventId: siappEventId } })).toBe(2);
    await prisma.setting.update({ where: { key: "key_value_cents" }, data: { value: 100 } });

    // Staff edits are refused; the staff key-cost override works and wins on the next push.
    await expect(updateOffer(full.id, { name: "x", type: "FREE_TICKET", keyCost: "1", allocationType: "CAPPED", capacity: "80" })).rejects.toBeInstanceOf(EventError);
    const overridden = await setOfferKeyCostOverride(full.id, 9);
    expect(overridden.keyCost).toBe(9);
    expect(overridden.plusOneExtraKeyCost).toBe(9);
    const after = await call(eventRoute.PUT as Handler, "PUT", path, EV, { body: snapshot(7, [fullOffer(80), discountOffer()]) });
    expect((after.body!.offers as any[]).find((o) => o.ref === `${EV}:tt_std:FULL`).keyCost).toBe(9);
    expect((await setOfferKeyCostOverride(full.id, null)).keyCost).toBe(15);
  });

  it("sales: counters, email only with cash, since + cursor; settlement 404", async () => {
    const m2 = await createMember();
    const disc = await prisma.offer.findFirstOrThrow({ where: { eventId: siappEventId, type: "DISCOUNT_TICKET" } });
    await grantPurchasedKeys(m2.id, 20, "PACK_PURCHASE");
    const pending = await prisma.redemption.create({ data: { memberId: m2.id, offerId: disc.id, eventId: siappEventId, status: "PENDING_PAYMENT", keyCost: 8, cashCents: 1200, cancelDeadlineAt: new Date(start.getTime() - DAY) } });
    await spendKeys(m2.id, 8, pending.id);

    const base = `/api/partner/v1/events/${EV}/sales`;
    const all = await call(salesRoute.GET as Handler, "GET", base, EV);
    expect(all.status).toBe(200);
    expect(all.body?.siappEventId).toBe(siappEventId);
    expect(all.body?.redemptions).toHaveLength(2);
    const free = all.body!.redemptions.find((r: any) => r.id === redemptionId);
    expect(free.member.email).toBeNull();
    expect(free.member.displayName).toMatch(/•••$/);
    expect(free.qrPayload).toBe("a".repeat(32));
    const paid = all.body!.redemptions.find((r: any) => r.cashCents === 1200);
    expect(paid.member.email).toBe(m2.email);
    expect(paid.status).toBe("PENDING_PAYMENT");
    const fullRes = all.body!.offers.find((o: any) => o.type === "FREE_TICKET");
    expect(fullRes.counters).toMatchObject({ active: 1, pendingPayment: 0 });

    const page1 = await call(salesRoute.GET as Handler, "GET", `${base}?limit=1`, EV);
    expect(page1.body?.redemptions).toHaveLength(1);
    expect(page1.body?.nextCursor).toBeTruthy();
    const page2 = await call(salesRoute.GET as Handler, "GET", `${base}?limit=1&cursor=${encodeURIComponent(page1.body!.nextCursor)}`, EV);
    expect(page2.body?.redemptions).toHaveLength(1);
    expect(page2.body?.redemptions[0].id).not.toBe(page1.body?.redemptions[0].id);
    expect(page2.body?.nextCursor).toBeNull();
    const since = await call(salesRoute.GET as Handler, "GET", `${base}?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, EV);
    expect(since.body?.redemptions).toHaveLength(0);

    const settle = await call(settlementRoute.GET as Handler, "GET", `/api/partner/v1/events/${EV}/settlement`, EV);
    expect(settle.status).toBe(404);
    expect(settle.body?.error.code).toBe("no_settlement");
  });

  it("photo: signature + signed route (ok / bad / expired / no-store)", async () => {
    const storage = makeMemoryStorage();
    setMediaStorageForTests(storage);
    try {
      const stored = await storage.put("selfies/m.jpg", Buffer.from("jpegbytes"), "image/jpeg");
      const ticket = await prisma.ticket.update({ where: { redemptionId }, data: { photoSnapshotUrl: stored.url } });
      const producer = await prisma.producer.findUniqueOrThrow({ where: { id: producerId } });
      const [secret] = webhookSecrets(producer);
      // Contract §1.3 test vector.
      expect(photoSignature("whsec_test", "tkt_abc", 1731600000)).toBe("4ba20657b14051cd1233c967fa5bb5998756d12d69d85cf55b4ff37bf2c2595b");
      const signed = await signedPhotoUrl(producer, ticket.id, end);
      expect(signed).not.toBeNull();
      const u = new URL(signed!.url);
      const exp = Number(u.searchParams.get("exp"));
      expect(exp).toBe(Math.floor((end.getTime() + 24 * 3_600_000) / 1000));
      expect(verifyPhotoSignature([secret!], ticket.id, exp, u.searchParams.get("sig")!)).toBe("ok");
      expect(verifyPhotoSignature([secret!], ticket.id, exp, "00")).toBe("bad");
      expect(verifyPhotoSignature([secret!], ticket.id, exp, u.searchParams.get("sig")!, new Date((exp + 1) * 1000))).toBe("expired");
      expect(verifyPhotoSignature(["other"], ticket.id, exp, u.searchParams.get("sig")!)).toBe("bad");

      const route = photoRoute.GET as unknown as (req: Request, ctx: { params: Promise<{ ticketId: string }> }) => Promise<Response>;
      const ok = await route(new Request(signed!.url), { params: Promise.resolve({ ticketId: ticket.id }) });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/jpeg");
      expect(ok.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("jpegbytes");
      const bad = await route(new Request(signed!.url.replace(/sig=.*$/, "sig=00")), { params: Promise.resolve({ ticketId: ticket.id }) });
      expect(bad.status).toBe(403);
      const expiredExp = Math.floor(Date.now() / 1000) - 10;
      const expired = await route(new Request(`http://localhost:3000/api/partner/v1/tickets/${ticket.id}/photo?exp=${expiredExp}&sig=${photoSignature(secret!, ticket.id, expiredExp)}`), { params: Promise.resolve({ ticketId: ticket.id }) });
      expect(expired.status).toBe(410);
      const unknown = await route(new Request("http://localhost:3000/api/partner/v1/tickets/nope/photo?exp=1&sig=00"), { params: Promise.resolve({ ticketId: "nope" }) });
      expect(unknown.status).toBe(404);
    } finally {
      setMediaStorageForTests(null);
    }
  });

  it("cancel: CANCELLED, keys back, idempotent; later pushes refused", async () => {
    const before = await prisma.keyBalance.findUniqueOrThrow({ where: { memberId: (await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } })).memberId } });
    const r = await call(cancelRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/cancel`, EV, { body: { reason: "venue flooded" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "CANCELLED", refunded: { redemptions: 2, keys: 23 } });
    const red = await prisma.redemption.findUniqueOrThrow({ where: { id: redemptionId } });
    expect(red.status).toBe("CANCELLED");
    const after = await prisma.keyBalance.findUniqueOrThrow({ where: { memberId: red.memberId } });
    expect(after.purchasedKeys).toBe(before.purchasedKeys + 15);
    const again = await call(cancelRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/cancel`, EV);
    expect(again.body?.refunded).toEqual({ redemptions: 0, keys: 0 });
    const push = await call(eventRoute.PUT as Handler, "PUT", `/api/partner/v1/events/${EV}`, EV, { body: snapshot(8, [fullOffer(80)]) });
    expect(push.status).toBe(409);
    expect((await call(publishRoute.POST as Handler, "POST", `/api/partner/v1/events/${EV}/publish`, EV)).status).toBe(409);
  });
});
