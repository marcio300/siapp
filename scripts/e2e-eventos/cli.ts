/**
 * SIAPP-side steps of the SIAPP ↔ EventOS end-to-end run (see EventOS
 * scripts/siapp-e2e/README.md). Every command prints one JSON object.
 *
 *   pnpm exec tsx scripts/e2e-eventos/cli.ts <command> [args…]
 *
 * Needs .env (DATABASE_URL, APP_URL, AUTH_SECRET, MEDIA_PROVIDER=local).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { prisma } from "../../src/lib/db";
import { createProducerApiKey } from "../../src/domain/partners-api/keys";
import { flushOutbound } from "../../src/domain/partners-api/outbox";
import { completeOnboarding } from "../../src/domain/identity/onboarding";
import { storeSelfie } from "../../src/domain/identity/photos";
import { ensureFreeSubscription, startPromoPeriod } from "../../src/domain/billing/subscriptions";
import { redeem } from "../../src/domain/redemption/redeem";
import { cancelRedemption, startRedemptionPayment, markNoShows } from "../../src/domain/redemption/lifecycle";
import { explainEligibility } from "../../src/domain/redemption/eligibility";
import { processScan } from "../../src/domain/scanner/scan";
import { getBalance } from "../../src/domain/keys/ledger";
import { generateReferralCode } from "../../src/lib/referral-code";

// 1×1 white JPEG
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
const [cmd, ...args] = process.argv.slice(2);
// Ensure the Phase-12 hooks see the same client


async function flush() {
  return flushOutbound({ db: prisma });
}

async function redemptionState(id: string) {
  const r = await prisma.redemption.findUniqueOrThrow({
    where: { id },
    include: { ticket: { include: { scans: true } }, offer: { select: { type: true, paymentMode: true, externalRef: true, keyCost: true } }, event: { select: { externalId: true, status: true, pausedAt: true } } },
  });
  const outbound = await prisma.outboundEvent.findMany({ where: { payload: { path: ["redemptionId"], equals: id } }, orderBy: { createdAt: "asc" } });
  const ledger = await prisma.keyTransaction.findMany({ where: { redemptionId: id }, select: { type: true, pool: true, amount: true } });
  const balance = await getBalance(r.memberId);
  return { redemption: r, outbound: outbound.map((o) => ({ id: o.id, type: o.type, status: o.status, attempts: o.attempts, responseStatus: o.responseStatus, responseBody: o.responseBody, lastError: o.lastError })), ledger, balance };
}

async function main() {
  switch (cmd) {
    case "producer": {
      const city = await prisma.city.findFirstOrThrow({ where: { name: "Lisbon" } });
      const producer = await prisma.producer.create({ data: { cityId: city.id, name: args[0] ?? "Lux E2E", usesEventOS: true, contactEmail: "producer@e2e.test" } });
      const key = await createProducerApiKey(producer.id, null);
      out({ producerId: producer.id, apiKey: key.plain, prefix: key.row.prefix });
      break;
    }
    case "producer-state": {
      const p = await prisma.producer.findUniqueOrThrow({ where: { id: args[0] } });
      out({ eventosOrgId: p.eventosOrgId, eventosWebhookUrl: p.eventosWebhookUrl, eventosAppUrl: p.eventosAppUrl, hasSecret: Boolean(p.eventosWebhookSecretEnc), connectedAt: p.eventosConnectedAt });
      break;
    }
    case "member": {
      const [email, name] = args;
      const city = await prisma.city.findFirstOrThrow({ where: { name: "Lisbon" } });
      const m = await prisma.member.create({ data: { email, cityId: city.id, referralCode: generateReferralCode(), emailVerified: new Date() } });
      await completeOnboarding(m.id, { name, dateOfBirth: "1995-05-05", cityId: city.id });
      await storeSelfie(m.id, { data: TINY_JPEG, contentType: "image/jpeg" });
      await ensureFreeSubscription(m.id);
      await startPromoPeriod({ memberId: m.id, tierCode: "REGULAR", months: 1, note: "e2e" });
      out({ memberId: m.id, email, balance: await getBalance(m.id) });
      break;
    }
    case "event": {
      const e = await prisma.event.findFirstOrThrow({ where: { externalId: args[0] }, include: { offers: true, producer: { select: { id: true, name: true } } } });
      out({ id: e.id, status: e.status, pausedAt: e.pausedAt, source: e.source, snapshotVersion: e.snapshotVersion, startsAt: e.startsAt, endsAt: e.endsAt, offers: e.offers.map((o) => ({ id: o.id, ref: o.externalRef, type: o.type, keyCost: o.keyCost, faceValueCents: o.faceValueCents, discountPercent: o.discountPercent, capacity: o.capacity, validUntil: o.validUntil, afterWindowBehaviour: o.afterWindowBehaviour, paymentMode: o.paymentMode, plusOneAllowed: o.plusOneAllowed, plusOneExtraCashCents: o.plusOneExtraCashCents })) });
      break;
    }
    case "redeem": {
      const [memberId, offerId, plusOneName] = args;
      const res = await redeem(memberId, offerId, { plusOneName: plusOneName ?? null });
      const report = await flush();
      out({ result: res, flush: report, state: await redemptionState(res.redemptionId) });
      break;
    }
    case "pay": {
      const [redemptionId, memberId] = args;
      try {
        const r = await startRedemptionPayment(redemptionId, memberId);
        out({ ok: true, ...r, state: await redemptionState(redemptionId) });
      } catch (e) {
        out({ ok: false, error: String((e as Error).message), detail: (e as { detail?: unknown }).detail, state: await redemptionState(redemptionId) });
      }
      break;
    }
    case "scan": {
      const [eventId, code] = args;
      const res = await processScan({ eventId, code, scannedBy: "siapp-door" });
      out({ result: res, flush: await flush() });
      break;
    }
    case "cancel": {
      const [redemptionId, memberId] = args;
      try {
        const r = await cancelRedemption(redemptionId, memberId === "staff" ? null : memberId);
        out({ ok: true, result: r, flush: await flush(), state: await redemptionState(redemptionId) });
      } catch (e) {
        out({ ok: false, error: String((e as Error).message), reason: (e as { reason?: string }).reason, state: await redemptionState(redemptionId) });
      }
      break;
    }
    case "eligibility": {
      const [memberId, offerId] = args;
      out(await explainEligibility(memberId, offerId));
      break;
    }
    case "flush":
      out(await flush());
      break;
    case "state":
      out(await redemptionState(args[0]));
      break;
    case "outbound": {
      const rows = await prisma.outboundEvent.findMany({ where: args[0] ? { eventId: args[0] } : {}, orderBy: { createdAt: "asc" } });
      out(rows.map((o) => ({ id: o.id, type: o.type, status: o.status, attempts: o.attempts, responseStatus: o.responseStatus, lastError: o.lastError, dedupeKey: o.dedupeKey })));
      break;
    }
    case "noshow": {
      const now = args[0] ? new Date(args[0]) : new Date();
      out({ now, result: await markNoShows({ now }) });
      break;
    }
    case "scans": {
      const rows = await prisma.scan.findMany({ where: { eventId: args[0] }, orderBy: { scannedAt: "asc" } });
      const stats = await prisma.attendanceStats.findMany({ where: { member: { redemptions: { some: { eventId: args[0] } } } } });
      out({ scans: rows.map((s) => ({ result: s.result, source: s.source, externalId: s.externalId, scannedBy: s.scannedBy, ticketId: s.ticketId })), stats });
      break;
    }
    case "sql": {
      out(await prisma.$queryRawUnsafe(args[0]));
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
