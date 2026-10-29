import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { refundKeys } from "@/domain/keys/ledger";
import { billingStripe } from "@/domain/billing/stripe-client";
import { ensureStripeCustomer } from "@/domain/billing/checkout";
import { RedemptionError } from "./errors";
import { emailNoShow } from "@/domain/notifications/emails";
import { notifyOnce } from "@/domain/notifications/log";
import { emailRedemptionCancelled, emailRedemptionConfirmed, emailWaitlistSpot } from "./notify";
import { issueTicket } from "./tickets";

/**
 * Everything that moves a redemption after creation: payment (Stripe
 * Checkout + webhook), fraud release, cancellation (24 h window, keys +
 * cash refunded), expiry of unpaid holds, no-shows, event cancellation, and
 * the waitlist hand-off that follows every freed seat.
 */
type Opts = { db?: PrismaClient; now?: Date };

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Stripe Checkout for a PENDING_PAYMENT redemption (reused on retry, idempotent per redemption). */
export async function startRedemptionPayment(redemptionId: string, memberId: string, opts: Opts = {}): Promise<{ url: string }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { offer: { include: { event: true } } } });
  if (!r || r.memberId !== memberId) throw new RedemptionError("NOT_FOUND", "Ticket not found");
  if (r.status !== "PENDING_PAYMENT") throw new RedemptionError("BAD_STATE", "Nothing to pay for this ticket");
  if (r.paymentExpiresAt && r.paymentExpiresAt <= now) throw new RedemptionError("TOO_LATE", "The payment window closed — redeem again");
  const customer = await ensureStripeCustomer(memberId, { db });
  const session = await billingStripe().checkout.sessions.create(
    {
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: r.cashCents, product_data: { name: `${r.offer.event.title} — ${r.offer.name}` } } }],
      success_url: `${appUrl()}/app/tickets/${r.id}?paid=1`,
      cancel_url: `${appUrl()}/app/tickets/${r.id}`,
      metadata: { kind: "redemption", memberId, redemptionId: r.id },
      payment_intent_data: { metadata: { kind: "redemption", memberId, redemptionId: r.id } },
      expires_at: Math.floor(r.paymentExpiresAt!.getTime() / 1000) < Math.floor(now.getTime() / 1000) + 30 * 60 ? Math.floor(now.getTime() / 1000) + 30 * 60 : Math.floor(r.paymentExpiresAt!.getTime() / 1000),
    },
    { idempotencyKey: `redemption_pay_${r.id}` },
  );
  if (!session.url) throw new RedemptionError("BAD_STATE", "Stripe did not return a Checkout URL");
  await db.redemption.update({ where: { id: r.id }, data: { stripeCheckoutSessionId: session.id } });
  return { url: session.url };
}

/** Webhook: payment confirmed → ACTIVE + ticket (+ remember the PaymentIntent for refunds). Idempotent. */
export async function completeRedemptionPayment(input: { redemptionId: string; checkoutSessionId: string; paymentIntentId: string | null }, opts: Opts = {}): Promise<"completed" | "already" | "ignored"> {
  const db = opts.db ?? defaultPrisma;
  const r = await db.redemption.findUnique({ where: { id: input.redemptionId }, include: { member: true, offer: { include: { event: { include: { city: true } } } } } });
  if (!r) return "ignored";
  if (r.status !== "PENDING_PAYMENT") {
    if (r.status === "ACTIVE" || r.status === "CHECKED_IN") return "already";
    // Expired/denied before the webhook arrived: the money must go back.
    if (input.paymentIntentId && !r.stripeRefundId) {
      const refund = await billingStripe().refunds.create({ payment_intent: input.paymentIntentId }, { idempotencyKey: `refund_late_${r.id}` });
      await db.redemption.update({ where: { id: r.id }, data: { stripeRefundId: refund.id, stripePaymentIntentId: input.paymentIntentId } });
    }
    return "ignored";
  }
  const claimed = await db.redemption.updateMany({
    where: { id: r.id, status: "PENDING_PAYMENT" },
    data: { status: "ACTIVE", stripeCheckoutSessionId: input.checkoutSessionId, stripePaymentIntentId: input.paymentIntentId, paymentExpiresAt: null },
  });
  if (claimed.count === 0) return "already";
  await issueTicket(db, { redemptionId: r.id, memberName: r.member.name ?? r.member.email, photoSnapshotUrl: r.member.selfieUrl, plusOneName: r.plusOneName });
  await emailRedemptionConfirmed({ to: r.member.email, eventTitle: r.offer.event.title, startsAt: r.offer.event.startsAt, timezone: r.offer.event.city.timezone, offerName: r.offer.name, keyCost: r.keyCost, cashCents: r.cashCents, plusOneName: r.plusOneName, redemptionId: r.id, cancelDeadlineAt: r.cancelDeadlineAt });
  return "completed";
}

/** Fraud approved a HELD redemption: ACTIVE + ticket, or PENDING_PAYMENT when cash is due (fresh window). */
export async function releaseHeldRedemption(redemptionId: string, opts: Opts = {}): Promise<"active" | "pending_payment" | "noop"> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { member: true, offer: { include: { event: { include: { city: true } } } } } });
  if (!r || r.status !== "HELD") return "noop";
  if (r.cashCents > 0) {
    const minutes = await getSetting("pending_payment_minutes");
    // Give the member a real chance to pay after a human review: at least 24 h.
    const paymentExpiresAt = new Date(now.getTime() + Math.max(minutes, 24 * 60) * 60_000);
    await db.redemption.update({ where: { id: r.id }, data: { status: "PENDING_PAYMENT", paymentExpiresAt } });
    return "pending_payment";
  }
  await db.redemption.update({ where: { id: r.id }, data: { status: "ACTIVE" } });
  await issueTicket(db, { redemptionId: r.id, memberName: r.member.name ?? r.member.email, photoSnapshotUrl: r.member.selfieUrl, plusOneName: r.plusOneName });
  await emailRedemptionConfirmed({ to: r.member.email, eventTitle: r.offer.event.title, startsAt: r.offer.event.startsAt, timezone: r.offer.event.city.timezone, offerName: r.offer.name, keyCost: r.keyCost, cashCents: 0, plusOneName: r.plusOneName, redemptionId: r.id, cancelDeadlineAt: r.cancelDeadlineAt });
  return "active";
}

/** Fraud denied a HELD redemption: keys back (no cash was taken yet), seat freed. */
export async function denyHeldRedemption(redemptionId: string, opts: Opts = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const res = await db.redemption.updateMany({ where: { id: redemptionId, status: "HELD" }, data: { status: "DENIED" } });
  if (res.count === 0) return false;
  await refundKeys(redemptionId, { note: "fraud review denied" }, { db, now }).catch(() => undefined);
  const r = await db.redemption.findUniqueOrThrow({ where: { id: redemptionId } });
  await notifyNextOnWaitlist(r.offerId, { db, now });
  return true;
}

/**
 * Member cancellation (spec §8): ACTIVE until `cancelDeadlineAt` (start −
 * window); PENDING_PAYMENT / HELD any time. Keys refunded to their pools,
 * cash refunded through Stripe, then the waitlist is offered the seat.
 */
export async function cancelRedemption(redemptionId: string, memberId: string | null, opts: Opts & { reason?: string } = {}): Promise<{ keysRefunded: number; cashRefundedCents: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { member: true, event: true } });
  if (!r || (memberId && r.memberId !== memberId)) throw new RedemptionError("NOT_FOUND", "Ticket not found");
  if (!["ACTIVE", "PENDING_PAYMENT", "HELD"].includes(r.status)) throw new RedemptionError("BAD_STATE", `This ticket is ${r.status.toLowerCase().replace("_", " ")}`);
  if (r.status === "ACTIVE" && now > r.cancelDeadlineAt) {
    throw new RedemptionError("TOO_LATE", "Too late to cancel — inside the cancellation window, tickets are final.", { deadline: r.cancelDeadlineAt.toISOString() });
  }
  const flipped = await db.redemption.updateMany({ where: { id: r.id, status: r.status }, data: { status: "CANCELLED", cancelledAt: now } });
  if (flipped.count === 0) throw new RedemptionError("BAD_STATE", "Ticket changed — try again");

  const refund = r.keyCost > 0 ? await refundKeys(r.id, { note: opts.reason ?? "cancelled by member" }, { db, now }) : { fromPlan: 0, fromPurchased: 0 };
  let cashRefundedCents = 0;
  if (r.status === "ACTIVE" && r.cashCents > 0 && r.stripePaymentIntentId && !r.stripeRefundId) {
    const stripeRefund = await billingStripe().refunds.create({ payment_intent: r.stripePaymentIntentId, amount: r.cashCents }, { idempotencyKey: `refund_${r.id}` });
    await db.redemption.update({ where: { id: r.id }, data: { stripeRefundId: stripeRefund.id } });
    cashRefundedCents = r.cashCents;
  }
  await notifyNextOnWaitlist(r.offerId, { db, now });
  await emailRedemptionCancelled({ to: r.member.email, eventTitle: r.event.title, keysRefunded: refund.fromPlan + refund.fromPurchased, cashCents: cashRefundedCents });
  return { keysRefunded: refund.fromPlan + refund.fromPurchased, cashRefundedCents };
}

/** Job (every 5 min): unpaid holds past their window → EXPIRED, keys back, seat offered to the waitlist. */
export async function expirePendingPayments(opts: Opts = {}): Promise<{ expired: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const due = await db.redemption.findMany({ where: { status: "PENDING_PAYMENT", paymentExpiresAt: { lte: now } } });
  let expired = 0;
  for (const r of due) {
    const res = await db.redemption.updateMany({ where: { id: r.id, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED" } });
    if (res.count === 0) continue;
    if (r.keyCost > 0) await refundKeys(r.id, { note: "payment window expired" }, { db, now });
    await notifyNextOnWaitlist(r.offerId, { db, now });
    expired++;
  }
  return { expired };
}

/**
 * Job (hourly): events that ended → ACTIVE redemptions become NO_SHOW (keys
 * forfeited, no refund row), attendance stats updated, event FINISHED.
 */
export async function markNoShows(opts: Opts = {}): Promise<{ noShows: number; finishedEvents: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const events = await db.event.findMany({ where: { status: "PUBLISHED", endsAt: { lte: now } }, select: { id: true } });
  let noShows = 0;
  for (const e of events) {
    const active = await db.redemption.findMany({ where: { eventId: e.id, status: "ACTIVE" }, include: { member: { select: { email: true } }, event: { select: { title: true } } } });
    for (const r of active) {
      const res = await db.redemption.updateMany({ where: { id: r.id, status: "ACTIVE" }, data: { status: "NO_SHOW" } });
      if (res.count === 0) continue;
      await db.attendanceStats.upsert({ where: { memberId: r.memberId }, update: { noShows: { increment: 1 } }, create: { memberId: r.memberId, noShows: 1 } });
      noShows++;
      await notifyOnce({ memberId: r.memberId, kind: "no_show", reference: r.id }, () => emailNoShow({ to: r.member.email, eventTitle: r.event.title, keysLost: r.keyCost }), { db, now });
    }
    // Unpaid holds on a finished event can't be paid any more.
    await db.redemption.updateMany({ where: { eventId: e.id, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED" } });
    await db.waitlistEntry.updateMany({ where: { offer: { eventId: e.id }, status: { in: ["WAITING", "NOTIFIED"] } }, data: { status: "EXPIRED" } });
    await db.event.update({ where: { id: e.id }, data: { status: "FINISHED" } });
  }
  return { noShows, finishedEvents: events.length };
}

/** Staff cancelled the event: every live redemption is refunded (keys + cash), waitlist closed. */
export async function refundEventRedemptions(eventId: string, opts: Opts = {}): Promise<{ refunded: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const live = await db.redemption.findMany({ where: { eventId, status: { in: ["ACTIVE", "PENDING_PAYMENT", "HELD"] } }, include: { member: true, event: true } });
  let refunded = 0;
  for (const r of live) {
    const res = await db.redemption.updateMany({ where: { id: r.id, status: r.status }, data: { status: "CANCELLED", cancelledAt: now } });
    if (res.count === 0) continue;
    if (r.keyCost > 0) await refundKeys(r.id, { note: "event cancelled" }, { db, now });
    let cash = 0;
    if (r.status === "ACTIVE" && r.cashCents > 0 && r.stripePaymentIntentId && !r.stripeRefundId) {
      const stripeRefund = await billingStripe().refunds.create({ payment_intent: r.stripePaymentIntentId, amount: r.cashCents }, { idempotencyKey: `refund_${r.id}` });
      await db.redemption.update({ where: { id: r.id }, data: { stripeRefundId: stripeRefund.id } });
      cash = r.cashCents;
    }
    await emailRedemptionCancelled({ to: r.member.email, eventTitle: r.event.title, keysRefunded: r.keyCost, cashCents: cash });
    refunded++;
  }
  await db.waitlistEntry.updateMany({ where: { offer: { eventId }, status: { in: ["WAITING", "NOTIFIED"] } }, data: { status: "EXPIRED" } });
  return { refunded };
}

// ---------------------------------------------------------------------------
// Waitlist (spec §7): CAPPED offers only. A freed seat goes to the first WAITING
// member, who gets `waitlist_claim_minutes` to redeem; the seat is reserved for
// them meanwhile (eligibility counts live claims of OTHER members as taken).
// ---------------------------------------------------------------------------

export async function joinWaitlist(memberId: string, offerId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const offer = await db.offer.findUnique({ where: { id: offerId }, include: { event: true } });
  if (!offer || offer.event.status !== "PUBLISHED") throw new RedemptionError("EVENT_NOT_OPEN", "This event isn't open.");
  if (offer.allocationType !== "CAPPED" || offer.capacity === null) throw new RedemptionError("BAD_STATE", "This offer has no waitlist.");
  if (now > (offer.redeemUntil ?? offer.event.startsAt)) throw new RedemptionError("OFFER_CLOSED", "Redemptions for this one have closed.");
  const used = await db.redemption.count({ where: { offerId, status: { in: ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"] } } });
  if (used < offer.capacity) throw new RedemptionError("BAD_STATE", "There are still spots — just redeem.");
  const own = await db.redemption.count({ where: { offerId, memberId, status: { in: ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"] } } });
  if (own >= offer.maxPerMember) throw new RedemptionError("MAX_PER_MEMBER", "You already have this one.");
  return db.waitlistEntry.upsert({
    where: { offerId_memberId: { offerId, memberId } },
    update: { status: "WAITING", notifiedAt: null, claimBy: null, createdAt: now },
    create: { offerId, memberId, createdAt: now },
  });
}

export async function leaveWaitlist(memberId: string, offerId: string, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const entry = await db.waitlistEntry.findUnique({ where: { offerId_memberId: { offerId, memberId } } });
  if (!entry || !["WAITING", "NOTIFIED"].includes(entry.status)) return false;
  await db.waitlistEntry.delete({ where: { id: entry.id } });
  if (entry.status === "NOTIFIED") await notifyNextOnWaitlist(offerId, { db, now });
  return true;
}

/** Offer a freed seat to the next WAITING member (if the offer is capped and actually has room). */
export async function notifyNextOnWaitlist(offerId: string, opts: Opts = {}): Promise<string | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const offer = await db.offer.findUnique({ where: { id: offerId }, include: { event: { include: { city: true } } } });
  if (!offer || offer.allocationType !== "CAPPED" || offer.capacity === null || offer.event.status !== "PUBLISHED") return null;
  if (now > (offer.redeemUntil ?? offer.event.startsAt)) return null;
  const [used, reserved] = await Promise.all([
    db.redemption.count({ where: { offerId, status: { in: ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"] } } }),
    db.waitlistEntry.count({ where: { offerId, status: "NOTIFIED", claimBy: { gt: now } } }),
  ]);
  if (used + reserved >= offer.capacity) return null;
  const next = await db.waitlistEntry.findFirst({ where: { offerId, status: "WAITING" }, orderBy: { createdAt: "asc" }, include: { member: true } });
  if (!next) return null;
  const minutes = await getSetting("waitlist_claim_minutes");
  const claimBy = new Date(now.getTime() + minutes * 60_000);
  await db.waitlistEntry.update({ where: { id: next.id }, data: { status: "NOTIFIED", notifiedAt: now, claimBy } });
  await emailWaitlistSpot({ to: next.member.email, eventTitle: offer.event.title, offerName: offer.name, claimBy, timezone: offer.event.city.timezone, eventId: offer.eventId });
  return next.memberId;
}

/** Job (every 5 min): claims that ran out → EXPIRED, seat passed to the next in line. */
export async function expireWaitlistClaims(opts: Opts = {}): Promise<{ expired: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const due = await db.waitlistEntry.findMany({ where: { status: "NOTIFIED", claimBy: { lte: now } } });
  let expired = 0;
  for (const e of due) {
    const res = await db.waitlistEntry.updateMany({ where: { id: e.id, status: "NOTIFIED" }, data: { status: "EXPIRED" } });
    if (res.count === 0) continue;
    expired++;
    await notifyNextOnWaitlist(e.offerId, { db, now });
  }
  return { expired };
}

export type RedemptionWithRelations = Prisma.RedemptionGetPayload<{ include: { offer: true; event: { include: { city: true } }; ticket: true } }>;
