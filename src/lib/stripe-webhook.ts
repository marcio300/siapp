import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Stripe webhook processing, separated from the HTTP route so it is testable
 * with synthetic events. Signature verification lives in
 * src/app/api/webhooks/stripe/route.ts and wraps this.
 *
 * Idempotency (CLAUDE.md rule 12, DATA_MODEL invariant 11): every Stripe
 * event id is stored in `StripeEvent`. A delivery whose id already has
 * `processedAt` set is a replay and returns without running any handler. A
 * handler that throws leaves `error` on the row and bubbles up (→ 500, so
 * Stripe retries); the retry runs the handler again because `processedAt` is
 * still null. Handlers must therefore be safe to re-run after a partial
 * failure — Phase 2 adds them (invoice.paid, checkout.session.completed, …).
 */

/** Structural subset of Stripe.Event — lets tests pass plain objects. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> & { id?: string } };
}

export interface WebhookOutcome {
  received: true;
  /** "processed" | "replay" | "ignored" */
  status: "processed" | "replay" | "ignored";
  note: string;
}

export type StripeEventHandler = (event: StripeWebhookEvent) => Promise<string | void>;

/** Handlers by event type. Phase 2 registers billing handlers here. */
const handlers: Record<string, StripeEventHandler> = {};

export function registerStripeHandler(type: string, handler: StripeEventHandler): void {
  handlers[type] = handler;
}

export async function handleStripeEvent(event: StripeWebhookEvent): Promise<WebhookOutcome> {
  // 1. Record the delivery. The primary key is Stripe's event id, so a
  //    concurrent duplicate delivery can't create a second row.
  let row;
  try {
    row = await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } });
    } else {
      throw e;
    }
  }

  // 2. Replay guard.
  if (row.processedAt) {
    return { received: true, status: "replay", note: "already processed (idempotent replay)" };
  }

  // 3. Dispatch. Unknown types are marked processed so a replay of them is
  //    also a no-op (and so the table doubles as a delivery log).
  const handler = handlers[event.type];
  if (!handler) {
    await prisma.stripeEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), error: null },
    });
    return { received: true, status: "ignored", note: `ignored event type ${event.type}` };
  }

  try {
    const note = (await handler(event)) ?? "ok";
    await prisma.stripeEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), error: null },
    });
    return { received: true, status: "processed", note };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.stripeEvent.update({ where: { id: event.id }, data: { error: message.slice(0, 1000) } });
    throw e;
  }
}
