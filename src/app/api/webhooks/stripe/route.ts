import { NextResponse } from "next/server";
import Stripe from "stripe";
import { handleStripeEvent, type StripeWebhookEvent } from "@/lib/stripe-webhook";

/**
 * Stripe webhook endpoint (ported from EventOS). Configure in Stripe →
 * {APP_URL}/api/webhooks/stripe. Local testing:
 *   stripe listen --forward-to localhost:3000/api/webhooks/stripe
 *
 * 400 = bad/missing signature (Stripe won't retry a forgery);
 * 200 = handled (including idempotent replays and ignored event types);
 * 500 = transient processing error (Stripe retries with backoff).
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Stripe webhook hit but STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // Signature verification needs the exact raw body — never re-serialize it.
  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    // constructEvent only needs the webhook secret; any key initialises the SDK.
    event = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_unused").webhooks.constructEvent(
      rawBody,
      signature,
      secret,
    );
  } catch (e) {
    console.error("Stripe webhook signature verification failed:", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handleStripeEvent(event as unknown as StripeWebhookEvent);
    return NextResponse.json(outcome);
  } catch (e) {
    console.error(`Stripe webhook processing failed for ${event.type} (${event.id}):`, e);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
