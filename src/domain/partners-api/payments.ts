import type { Prisma, PrismaClient, RedemptionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { refundKeys } from "@/domain/keys/ledger";
import { inviteeLabel } from "@/domain/referrals/status";
import { signQrPayload } from "@/domain/redemption/tickets";
import { emailRedemptionConfirmed } from "@/domain/redemption/notify";
import { webhookSecrets } from "./connect";
import { PartnerApiError, validationFailed } from "./errors";
import { notifySalesUpdated, ticketTypeIdFromRef } from "./hooks";
import { memberPriceCents } from "./pricing";
import { currentOutboundFetch, signatureHeader, ulid } from "./outbox";
import { signedPhotoUrl } from "./photo";

/**
 * Producer-collects payments (docs/EVENTOS_INTEGRATION.md, contract §4.2 +
 * §3.8). For a DISCOUNT_TICKET offer with `paymentMode = PRODUCER_COLLECTS`
 * the member pays the PRODUCER through EventOS checkout:
 *
 *   redeem() ─ PENDING_PAYMENT, keys spent, QR payload minted ─┐
 *   requestExternalOrder() → EventOS `order.create` (synchronous command,
 *     signed like the outbox) → { orderId, payUrl, holdExpiresAt } stored,
 *     member redirected to the producer's checkout
 *   EventOS → POST /redemptions/{id}/payment `order.paid` → ACTIVE + Ticket
 *     whose qrPayload is the one we minted (EventOS adopted it as qrToken)
 *   …or `order.expired` → EXPIRED, keys back; `refund.*` → bookkeeping.
 *
 * No Stripe is involved and nothing is settled (CLAUDE.md rules 6 + 10).
 */
type Db = PrismaClient | Prisma.TransactionClient;
type Opts = { db?: PrismaClient; now?: Date; fetchImpl?: typeof fetch };

/** Terminal refusals from EventOS (contract §4.2): the redemption is cancelled and the keys go back. */
export const ORDER_CREATE_TERMINAL = ["sold_out", "price_mismatch", "event_not_live", "offer_unknown", "discount_below_floor"] as const;
export type OrderCreateTerminalCode = (typeof ORDER_CREATE_TERMINAL)[number];

export class ExternalOrderError extends Error {
  constructor(
    public readonly code: OrderCreateTerminalCode | "unavailable" | "not_connected" | "bad_reply",
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "ExternalOrderError";
  }
  get terminal(): boolean {
    return (ORDER_CREATE_TERMINAL as readonly string[]).includes(this.code);
  }
}

/** Member-facing copy for each refusal (the redeem sheet shows it via `?error=`). */
export const ORDER_CREATE_MESSAGES: Record<OrderCreateTerminalCode, string> = {
  sold_out: "The producer's last seats went while you were deciding. Your keys are back in your wallet.",
  price_mismatch: "The price changed on the producer's side. Your keys are back — have another look at the offer.",
  event_not_live: "This event isn't on sale right now. Your keys are back in your wallet.",
  offer_unknown: "This offer is no longer available. Your keys are back in your wallet.",
  discount_below_floor: "This offer is misconfigured on the producer's side — we've flagged it. Your keys are back.",
};

export interface ExternalOrder {
  orderId: string;
  payUrl: string;
  holdExpiresAt: Date;
  totalCents: number;
  /** A live hold already existed (retry from the ticket page). */
  reused: boolean;
}

const OrderReplySchema = z.object({
  orderId: z.string().min(1),
  payUrl: z.string().url(),
  holdExpiresAt: z.string().datetime({ offset: true }),
  totalCents: z.number().int().nonnegative().optional(),
});

/**
 * Ask the producer's EventOS for a held order + pay link (contract §4.2). A
 * still-valid link already stored on the redemption is returned as is; on a
 * terminal refusal the redemption is CANCELLED and the keys refunded before
 * the error is thrown, so the caller only has to show the message.
 */
export async function requestExternalOrder(redemptionId: string, opts: Opts = {}): Promise<ExternalOrder> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? currentOutboundFetch();
  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { member: true, offer: true, event: { include: { producer: true } } } });
  if (!r) throw new ExternalOrderError("bad_reply", "Redemption not found");
  if (r.offer.paymentMode !== "PRODUCER_COLLECTS") throw new ExternalOrderError("bad_reply", "Not a producer-collects redemption");
  const producer = r.event.producer;
  const [secret] = webhookSecrets(producer, now);
  if (!producer.eventosOrgId || !producer.eventosWebhookUrl || !secret || !r.event.externalId || !r.offer.externalRef) {
    throw new ExternalOrderError("not_connected", "The producer is not connected to EventOS");
  }
  if (r.externalOrderId && r.externalPayUrl && r.paymentExpiresAt && r.paymentExpiresAt > now) {
    return { orderId: r.externalOrderId, payUrl: r.externalPayUrl, holdExpiresAt: r.paymentExpiresAt, totalCents: r.cashCents, reused: true };
  }

  const holdMinutes = await getSetting("partner_payment_hold_minutes", db);
  const face = r.offer.faceValueCents ?? 0;
  const discount = r.offer.discountPercent ?? 0;
  const photo = r.member.selfieUrl ? await signedPhotoUrl(producer, `redemption:${r.id}`, r.event.endsAt, { db, now }) : null;
  const data = {
    redemptionId: r.id,
    siappEventId: r.eventId,
    eventosEventId: r.event.externalId,
    ticketTypeId: ticketTypeIdFromRef(r.offer.externalRef),
    offerRef: r.offer.externalRef,
    qrPayload: r.qrPayload,
    unitPriceCents: memberPriceCents(face, discount),
    faceValueCents: face,
    discountPercent: discount,
    plusOne: r.plusOneName ? { name: r.plusOneName, extraCashCents: r.offer.plusOneExtraCashCents ?? 0 } : null,
    expectedTotalCents: r.cashCents,
    buyer: { name: r.member.name ?? inviteeLabel(r.member), email: r.member.email },
    holdMinutes,
    memberDisplayName: inviteeLabel(r.member),
    photoUrl: photo?.url ?? null,
    photoExpiresAt: photo?.expiresAt.toISOString() ?? null,
  };
  const envelope = { id: ulid(now), type: "order.create", producerId: producer.id, eventosOrgId: producer.eventosOrgId, createdAt: now.toISOString(), data };
  const body = JSON.stringify(envelope);

  let status = 0;
  let text = "";
  try {
    const res = await fetchImpl(producer.eventosWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-siapp-signature": signatureHeader(secret, body, now), "x-request-id": envelope.id },
      body,
    });
    status = res.status;
    text = await res.text().catch(() => "");
  } catch (e) {
    throw new ExternalOrderError("unavailable", `EventOS unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (status >= 200 && status < 300) {
    const parsed = OrderReplySchema.safeParse(json);
    if (!parsed.success) throw new ExternalOrderError("bad_reply", `EventOS answered without an order (${text.slice(0, 200)})`, status);
    const holdExpiresAt = new Date(parsed.data.holdExpiresAt);
    await db.redemption.updateMany({
      where: { id: r.id, status: "PENDING_PAYMENT" },
      data: { externalOrderId: parsed.data.orderId, externalPayUrl: parsed.data.payUrl, paymentExpiresAt: holdExpiresAt },
    });
    return { orderId: parsed.data.orderId, payUrl: parsed.data.payUrl, holdExpiresAt, totalCents: parsed.data.totalCents ?? r.cashCents, reused: false };
  }
  const code = (json as { error?: { code?: string } } | null)?.error?.code;
  if (status < 500 && status !== 408 && status !== 429 && code && (ORDER_CREATE_TERMINAL as readonly string[]).includes(code)) {
    const terminal = code as OrderCreateTerminalCode;
    // The producer refused: nothing was held on their side, so just give the keys back.
    const flipped = await db.redemption.updateMany({ where: { id: r.id, status: "PENDING_PAYMENT" }, data: { status: "CANCELLED", cancelledAt: now } });
    if (flipped.count > 0 && r.keyCost > 0) await refundKeys(r.id, { note: `eventos refused order: ${terminal}` }, { db, now }).catch(() => undefined);
    await notifySalesUpdated(r.eventId, { db, now });
    throw new ExternalOrderError(terminal, ORDER_CREATE_MESSAGES[terminal], status);
  }
  throw new ExternalOrderError("unavailable", `EventOS answered HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`, status);
}

// ---------------------------------------------------------------------------
// Inbound: POST /api/partner/v1/redemptions/{id}/payment (contract §3.8)
// ---------------------------------------------------------------------------

export const PaymentEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("order.paid"),
    orderId: z.string().min(1),
    paidAt: z.string().datetime({ offset: true }).optional(),
    amountCents: z.number().int().nonnegative().optional(),
    ticket: z.object({ id: z.string().min(1), qrToken: z.string().min(1) }),
  }),
  z.object({ kind: z.literal("order.expired"), orderId: z.string().min(1), expiredAt: z.string().datetime({ offset: true }).optional() }),
  z.object({ kind: z.literal("refund.succeeded"), orderId: z.string().min(1), refundId: z.string().min(1).optional(), amountCents: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal("refund.failed"), orderId: z.string().min(1), refundId: z.string().min(1).optional(), amountCents: z.number().int().nonnegative().optional(), error: z.string().max(500).optional() }),
]);
export type PaymentEvent = z.infer<typeof PaymentEventSchema>;

export interface PaymentOutcome {
  redemptionStatus: RedemptionStatus;
  outcome: "completed" | "expired" | "recorded" | "noop";
  ticketId?: string;
}

/** EventOS reports what happened to the producer's order for this redemption. Idempotent per kind. */
export async function completeExternalPayment(producerId: string, redemptionId: string, raw: unknown, opts: Omit<Opts, "fetchImpl"> = {}): Promise<PaymentOutcome> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = PaymentEventSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join("."), code: "invalid", message: i.message })));
  const input = parsed.data;

  const r = await db.redemption.findUnique({ where: { id: redemptionId }, include: { member: true, ticket: true, offer: true, event: { include: { city: true } } } });
  if (!r) throw new PartnerApiError(404, "not_found", "Unknown redemption");
  if (r.event.producerId !== producerId) throw new PartnerApiError(403, "forbidden", "This redemption belongs to another producer");

  switch (input.kind) {
    case "order.paid": {
      if (r.status !== "PENDING_PAYMENT") return { redemptionStatus: r.status, outcome: "noop", ticketId: r.ticket?.id };
      const qrPayload = r.qrPayload ?? input.ticket.qrToken;
      if (input.ticket.qrToken !== qrPayload) throw new PartnerApiError(409, "qr_mismatch", "The EventOS ticket token does not match the QR payload SIAPP minted for this redemption");
      const out = await db.$transaction(async (tx) => {
        const claimed = await tx.redemption.updateMany({
          where: { id: r.id, status: "PENDING_PAYMENT" },
          data: { status: "ACTIVE", paymentExpiresAt: null, externalOrderId: input.orderId, ...(r.qrPayload ? {} : { qrPayload }) },
        });
        if (claimed.count === 0) return null;
        const ticket = await tx.ticket.create({
          data: {
            redemptionId: r.id,
            qrPayload,
            signature: signQrPayload(qrPayload),
            memberName: r.member.name ?? r.member.email,
            photoSnapshotUrl: r.member.selfieUrl,
            plusOneName: r.plusOneName,
            externalTicketId: input.ticket.id,
            externalOrderId: input.orderId,
          },
        });
        // A waitlist claim that was being used is consumed (mirrors redeem()).
        await tx.waitlistEntry.updateMany({ where: { offerId: r.offerId, memberId: r.memberId, status: "NOTIFIED" }, data: { status: "CLAIMED" } });
        return ticket;
      });
      if (!out) {
        const fresh = await db.redemption.findUniqueOrThrow({ where: { id: r.id }, include: { ticket: true } });
        return { redemptionStatus: fresh.status, outcome: "noop", ticketId: fresh.ticket?.id };
      }
      await emailRedemptionConfirmed({ to: r.member.email, eventTitle: r.event.title, startsAt: r.event.startsAt, timezone: r.event.city.timezone, offerName: r.offer.name, keyCost: r.keyCost, cashCents: r.cashCents, plusOneName: r.plusOneName, redemptionId: r.id, cancelDeadlineAt: r.cancelDeadlineAt });
      await notifySalesUpdated(r.eventId, { db, now });
      return { redemptionStatus: "ACTIVE", outcome: "completed", ticketId: out.id };
    }
    case "order.expired": {
      if (r.status !== "PENDING_PAYMENT") return { redemptionStatus: r.status, outcome: "noop" };
      const res = await db.redemption.updateMany({ where: { id: r.id, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED", externalPayUrl: null } });
      if (res.count === 0) return { redemptionStatus: (await db.redemption.findUniqueOrThrow({ where: { id: r.id } })).status, outcome: "noop" };
      if (r.keyCost > 0) await refundKeys(r.id, { note: "eventos hold expired" }, { db, now }).catch(() => undefined);
      // Lazy import: lifecycle imports the hooks, which import this module's neighbours.
      const { notifyNextOnWaitlist } = await import("@/domain/redemption/lifecycle");
      await notifyNextOnWaitlist(r.offerId, { db, now });
      await notifySalesUpdated(r.eventId, { db, now });
      return { redemptionStatus: "EXPIRED", outcome: "expired" };
    }
    case "refund.succeeded": {
      await db.redemption.update({ where: { id: r.id }, data: { externalRefundedAt: r.externalRefundedAt ?? now, externalRefundError: null } });
      return { redemptionStatus: r.status, outcome: "recorded" };
    }
    case "refund.failed": {
      await db.redemption.update({ where: { id: r.id }, data: { externalRefundError: (input.error ?? "refund failed at the producer's gateway").slice(0, 500) } });
      return { redemptionStatus: r.status, outcome: "recorded" };
    }
  }
}

/** Convenience for pages: does this offer's cash go to the producer? */
export function collectsViaProducer(offer: { type: string; paymentMode: string }): boolean {
  return offer.type === "DISCOUNT_TICKET" && offer.paymentMode === "PRODUCER_COLLECTS";
}

export type { Db as PartnerDb };
