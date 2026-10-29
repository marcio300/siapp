import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";

/**
 * The slice of the Stripe SDK billing touches, so tests can inject a fake.
 * The real `Stripe` instance satisfies it structurally.
 */
export interface BillingStripe {
  customers: {
    create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string; url: string | null }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<{ id: string; items: { data: { id: string; price: { id: string } }[] } }>;
    update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
  };
  billingPortal: {
    sessions: { create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }> };
  };
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>;
  };
}

let override: BillingStripe | null = null;

export function billingStripe(): BillingStripe {
  return override ?? (getStripe() as unknown as BillingStripe);
}

/** Test seam — inert in production. */
export function setBillingStripeForTests(stub: BillingStripe | null): void {
  if (process.env.NODE_ENV === "production") return;
  override = stub;
}
