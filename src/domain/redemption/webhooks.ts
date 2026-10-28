import { registerStripeHandler, type StripeWebhookEvent } from "@/lib/stripe-webhook";
import { completeRedemptionPayment } from "./lifecycle";

/**
 * checkout.session.completed / async_payment_succeeded with
 * metadata.kind === "redemption" → complete the PENDING_PAYMENT redemption.
 * Other session kinds are the billing domain's (it returns null for ours).
 */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const refId = (v: unknown): string | null => (typeof v === "string" ? v : typeof obj(v)?.id === "string" ? (obj(v)!.id as string) : null);

export async function handleRedemptionSession(event: StripeWebhookEvent): Promise<string | null> {
  const session = event.data.object as Obj;
  const meta = (obj(session.metadata) ?? {}) as Record<string, string>;
  if (meta.kind !== "redemption" || !meta.redemptionId) return null;
  if (session.payment_status && session.payment_status !== "paid") return `redemption session ${session.id} ${session.payment_status} — awaiting async confirmation`;
  const outcome = await completeRedemptionPayment({ redemptionId: meta.redemptionId, checkoutSessionId: String(session.id), paymentIntentId: refId(session.payment_intent) });
  return `redemption ${meta.redemptionId}: ${outcome}`;
}

let registered = false;
export function registerRedemptionWebhooks(): void {
  if (registered) return;
  registered = true;
  registerStripeHandler("checkout.session.completed", handleRedemptionSession);
  registerStripeHandler("checkout.session.async_payment_succeeded", handleRedemptionSession);
}
