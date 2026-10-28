import Stripe from "stripe";

/**
 * Stripe client (ported from EventOS). Lazy singleton so importing this
 * module never requires the key — only calling getStripe() does.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set — add it to .env (and STRIPE_WEBHOOK_SECRET)");
    }
    client = new Stripe(key);
  }
  return client;
}

/** Test seam: inject a client (e.g. a stub) — ignored in production. */
export function setStripeClientForTests(stub: Stripe | null): void {
  if (process.env.NODE_ENV === "production") return;
  client = stub;
}
