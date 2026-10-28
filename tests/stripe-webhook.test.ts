import Stripe from "stripe";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleStripeEvent, registerStripeHandler } from "@/lib/stripe-webhook";
import { POST } from "@/app/api/webhooks/stripe/route";
import { prisma, resetDatabase } from "./db";

function event(id: string, type: string, object: Record<string, unknown> = {}) {
  return { id, type, data: { object: { id: `obj_${id}`, ...object } } };
}

describe("Stripe webhook idempotency (DATA_MODEL invariant 11)", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("records unknown event types and treats a redelivery as a replay", async () => {
    const first = await handleStripeEvent(event("evt_1", "some.unhandled_type"));
    expect(first.status).toBe("ignored");
    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_1" } });
    expect(row.type).toBe("some.unhandled_type");
    expect(row.processedAt).not.toBeNull();

    const again = await handleStripeEvent(event("evt_1", "some.unhandled_type"));
    expect(again.status).toBe("replay");
    expect(await prisma.stripeEvent.count()).toBe(1);
  });

  it("runs a registered handler exactly once across replays", async () => {
    let calls = 0;
    registerStripeHandler("test.counted", async () => {
      calls++;
      return `call ${calls}`;
    });
    expect((await handleStripeEvent(event("evt_2", "test.counted"))).status).toBe("processed");
    expect((await handleStripeEvent(event("evt_2", "test.counted"))).status).toBe("replay");
    expect((await handleStripeEvent(event("evt_2", "test.counted"))).status).toBe("replay");
    expect(calls).toBe(1);
  });

  it("stores the error and re-runs the handler on retry after a failure", async () => {
    let attempts = 0;
    registerStripeHandler("test.flaky", async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient boom");
    });
    await expect(handleStripeEvent(event("evt_3", "test.flaky"))).rejects.toThrow("transient boom");
    let row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_3" } });
    expect(row.processedAt).toBeNull();
    expect(row.error).toBe("transient boom");

    expect((await handleStripeEvent(event("evt_3", "test.flaky"))).status).toBe("processed");
    row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_3" } });
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toBeNull();
    expect(attempts).toBe(2);

    expect((await handleStripeEvent(event("evt_3", "test.flaky"))).status).toBe("replay");
    expect(attempts).toBe(2);
  });
});

describe("POST /api/webhooks/stripe", () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  const stripe = new Stripe("sk_test_unused");
  const payload = JSON.stringify(event("evt_route_1", "customer.created", { object: "customer" }));

  function request(body: string, signature?: string) {
    return new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: signature ? { "stripe-signature": signature, "content-type": "application/json" } : {},
      body,
    });
  }

  it("verifies the signature, records the event, and dedupes the replay", async () => {
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const res = await POST(request(payload, signature));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, status: "ignored" });
    expect(await prisma.stripeEvent.findUnique({ where: { id: "evt_route_1" } })).not.toBeNull();

    const replay = await POST(request(payload, stripe.webhooks.generateTestHeaderString({ payload, secret })));
    expect(await replay.json()).toMatchObject({ status: "replay" });
  });

  it("rejects a bad or missing signature with 400 and records nothing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forged = JSON.stringify(event("evt_forged", "customer.created"));
    const bad = await POST(request(forged, stripe.webhooks.generateTestHeaderString({ payload: forged, secret: "whsec_wrong" })));
    expect(bad.status).toBe(400);
    const missing = await POST(request(forged));
    expect(missing.status).toBe(400);
    expect(await prisma.stripeEvent.findUnique({ where: { id: "evt_forged" } })).toBeNull();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});
