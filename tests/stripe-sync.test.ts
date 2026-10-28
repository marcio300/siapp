import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { recurringFor, syncStripePrices, type StripeLike } from "../scripts/sync-stripe-prices";
import { prisma, resetDatabase } from "./db";

/** In-memory Stripe: products + immutable prices, like the real thing. */
function fakeStripe() {
  const products = new Map<string, { id: string; name: string }>();
  const prices = new Map<string, { id: string; product: string; unit_amount: number | null; currency: string; active: boolean; recurring: { interval: string; interval_count: number } | null }>();
  const calls = { productCreate: 0, productUpdate: 0, priceCreate: 0, priceUpdate: 0 };
  const stripe: StripeLike = {
    products: {
      async create(params) {
        calls.productCreate++;
        const id = `prod_${products.size + 1}`;
        products.set(id, { id, name: params.name });
        return { id };
      },
      async update(id, params) {
        calls.productUpdate++;
        const p = products.get(id);
        if (!p) throw new Error(`no such product ${id}`);
        if (params.name) p.name = params.name;
        return { id };
      },
    },
    prices: {
      async create(params) {
        calls.priceCreate++;
        const id = `price_${prices.size + 1}`;
        prices.set(id, {
          id,
          product: String(params.product),
          unit_amount: params.unit_amount ?? null,
          currency: params.currency,
          active: true,
          recurring: params.recurring ? { interval: params.recurring.interval, interval_count: params.recurring.interval_count ?? 1 } : null,
        });
        return { id };
      },
      async retrieve(id) {
        const p = prices.get(id);
        if (!p) throw new Error(`no such price ${id}`);
        return p;
      },
      async update(id, params) {
        calls.priceUpdate++;
        const p = prices.get(id);
        if (!p) throw new Error(`no such price ${id}`);
        if (params.active !== undefined) p.active = params.active;
        return { id };
      },
    },
  };
  return { stripe, products, prices, calls };
}

describe("scripts/sync-stripe-prices", () => {
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
  });

  it("creates a product per paid plan/pack and a price per PlanPrice, storing the ids", async () => {
    const fake = fakeStripe();
    const result = await syncStripePrices(prisma, fake.stripe);

    // 9 paid plans + tourist + 2 packs = 12 products; FREE gets none.
    expect(result.productsCreated).toBe(12);
    expect(result.pricesCreated).toBe(12);
    expect(fake.calls.productCreate).toBe(12);

    const plans = await prisma.plan.findMany({ include: { prices: true, tier: true } });
    for (const plan of plans) {
      const price = plan.prices[0]!;
      if (price.amountCents === 0) {
        expect(plan.stripeProductId).toBeNull();
        expect(price.stripePriceId).toBeNull();
        continue;
      }
      expect(plan.stripeProductId).toMatch(/^prod_/);
      expect(price.stripePriceId).toMatch(/^price_/);
      const stripePrice = fake.prices.get(price.stripePriceId!)!;
      expect(stripePrice.unit_amount).toBe(price.amountCents);
      expect(stripePrice.currency).toBe("eur");
      expect(stripePrice.product).toBe(plan.stripeProductId);
      expect(stripePrice.recurring).toEqual(recurringFor(plan.period));
    }
    const tourist = plans.find((p) => p.period === "TOURIST_WEEK")!;
    expect(fake.prices.get(tourist.prices[0]!.stripePriceId!)!.recurring).toBeNull();

    const packs = await prisma.keyPack.findMany();
    for (const pack of packs) {
      expect(pack.stripeProductId).toMatch(/^prod_/);
      expect(fake.prices.get(pack.stripePriceId!)).toMatchObject({ unit_amount: pack.amountCents, recurring: null });
    }

    // Second run: nothing new, names re-synced only.
    const again = await syncStripePrices(prisma, fake.stripe);
    expect(again.pricesCreated).toBe(0);
    expect(again.productsCreated).toBe(0);
    expect(fake.calls.priceCreate).toBe(12);
  });

  it("creates a new price and archives the old one when the amount changes", async () => {
    const fake = fakeStripe();
    await prisma.plan.updateMany({ data: { stripeProductId: null } });
    await prisma.planPrice.updateMany({ data: { stripePriceId: null } });
    await prisma.keyPack.updateMany({ data: { stripeProductId: null, stripePriceId: null } });
    await syncStripePrices(prisma, fake.stripe);

    const social = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } }, include: { prices: true } });
    const oldPriceId = social.prices[0]!.stripePriceId!;
    await prisma.planPrice.update({ where: { id: social.prices[0]!.id }, data: { amountCents: 1700 } });

    const result = await syncStripePrices(prisma, fake.stripe);
    expect(result.pricesCreated).toBe(1);
    expect(result.pricesArchived).toBe(1);

    const updated = await prisma.planPrice.findUniqueOrThrow({ where: { id: social.prices[0]!.id } });
    expect(updated.stripePriceId).not.toBe(oldPriceId);
    expect(fake.prices.get(oldPriceId)!.active).toBe(false);
    expect(fake.prices.get(updated.stripePriceId!)).toMatchObject({ unit_amount: 1700, active: true, product: social.stripeProductId });
  });

  it("dry run touches neither Stripe nor the database", async () => {
    const fake = fakeStripe();
    await prisma.plan.updateMany({ data: { stripeProductId: null } });
    await prisma.planPrice.updateMany({ data: { stripePriceId: null } });
    await prisma.keyPack.updateMany({ data: { stripeProductId: null, stripePriceId: null } });
    const result = await syncStripePrices(prisma, fake.stripe, { dryRun: true });
    expect(result.productsCreated).toBe(12);
    expect(result.pricesCreated).toBe(12);
    expect(fake.calls.productCreate).toBe(0);
    expect(fake.calls.priceCreate).toBe(0);
    expect(await prisma.keyPack.count({ where: { stripeProductId: null } })).toBe(2);
  });
});
