/**
 * Create/update Stripe Products and Prices from the Plan / PlanPrice / KeyPack
 * rows and store the ids back (CLAUDE.md: "Plan maps to a Stripe Price").
 *
 *   pnpm stripe:sync-prices            # needs DATABASE_URL + STRIPE_SECRET_KEY
 *   pnpm stripe:sync-prices --dry-run  # print what would change
 *
 * Rules:
 * - One Stripe Product per Plan and per KeyPack (name kept in sync).
 * - One Stripe Price per PlanPrice (city × currency) and per KeyPack. Stripe
 *   prices are immutable, so when the amount/currency/interval differ from the
 *   stored price, a NEW price is created and the old one is archived
 *   (active=false) — existing subscriptions keep their old price until Phase 2
 *   migrates them explicitly.
 * - €0 plans (FREE) get no Stripe objects.
 * - Idempotency keys on every create, so a crash between "created at Stripe"
 *   and "stored the id" is safe to re-run.
 */
import "dotenv/config";
import type { BillingPeriod, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";

export interface SyncLog {
  (msg: string): void;
}

/** The slice of the Stripe SDK we touch — lets tests pass a stub. */
export type StripeLike = {
  products: {
    create(params: Stripe.ProductCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>;
    update(id: string, params: Stripe.ProductUpdateParams): Promise<{ id: string }>;
  };
  prices: {
    create(params: Stripe.PriceCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>;
    retrieve(id: string): Promise<{
      id: string;
      unit_amount: number | null;
      currency: string;
      active: boolean;
      recurring: { interval: string; interval_count: number } | null;
    }>;
    update(id: string, params: Stripe.PriceUpdateParams): Promise<{ id: string }>;
  };
};

export interface SyncResult {
  productsCreated: number;
  productsUpdated: number;
  pricesCreated: number;
  pricesArchived: number;
  skipped: number;
}

export function recurringFor(period: BillingPeriod): Stripe.PriceCreateParams.Recurring | null {
  switch (period) {
    case "MONTHLY":
      return { interval: "month", interval_count: 1 };
    case "QUARTERLY":
      return { interval: "month", interval_count: 3 };
    case "YEARLY":
      return { interval: "year", interval_count: 1 };
    case "TOURIST_WEEK":
      return null; // one-off purchase, no renewal (spec §3)
  }
}

function sameRecurring(
  a: { interval: string; interval_count: number } | null,
  b: Stripe.PriceCreateParams.Recurring | null,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.interval === b.interval && a.interval_count === (b.interval_count ?? 1);
}

export async function syncStripePrices(
  prisma: PrismaClient,
  stripe: StripeLike,
  opts: { dryRun?: boolean; log?: SyncLog } = {},
): Promise<SyncResult> {
  const log = opts.log ?? (() => undefined);
  const dry = opts.dryRun ?? false;
  const result: SyncResult = { productsCreated: 0, productsUpdated: 0, pricesCreated: 0, pricesArchived: 0, skipped: 0 };

  /** Returns the Stripe price id to store, creating/archiving as needed. */
  async function ensurePrice(input: {
    key: string; // stable handle for idempotency keys + logs
    productId: string;
    currentPriceId: string | null;
    amountCents: number;
    currency: string;
    recurring: Stripe.PriceCreateParams.Recurring | null;
    metadata: Record<string, string>;
  }): Promise<string | null> {
    const currency = input.currency.toLowerCase();
    if (input.currentPriceId) {
      const existing = await stripe.prices.retrieve(input.currentPriceId);
      const unchanged =
        existing.active &&
        existing.unit_amount === input.amountCents &&
        existing.currency === currency &&
        sameRecurring(existing.recurring, input.recurring);
      if (unchanged) {
        result.skipped++;
        return input.currentPriceId;
      }
      log(`${input.key}: price changed → archiving ${input.currentPriceId}`);
      if (!dry) await stripe.prices.update(input.currentPriceId, { active: false });
      result.pricesArchived++;
    }
    log(`${input.key}: creating price ${input.amountCents} ${currency}${input.recurring ? ` / ${input.recurring.interval_count ?? 1} ${input.recurring.interval}` : " one-off"}`);
    result.pricesCreated++;
    if (dry) return input.currentPriceId;
    const price = await stripe.prices.create(
      {
        product: input.productId,
        unit_amount: input.amountCents,
        currency,
        ...(input.recurring ? { recurring: input.recurring } : {}),
        metadata: input.metadata,
      },
      { idempotencyKey: `price_${input.key}_${input.amountCents}_${currency}_${input.recurring?.interval ?? "once"}${input.recurring?.interval_count ?? ""}` },
    );
    return price.id;
  }

  async function ensureProduct(input: { key: string; currentProductId: string | null; name: string; metadata: Record<string, string> }): Promise<string | null> {
    if (input.currentProductId) {
      log(`${input.key}: product ${input.currentProductId} — syncing name "${input.name}"`);
      result.productsUpdated++;
      if (!dry) await stripe.products.update(input.currentProductId, { name: input.name, metadata: input.metadata });
      return input.currentProductId;
    }
    log(`${input.key}: creating product "${input.name}"`);
    result.productsCreated++;
    if (dry) return null;
    const product = await stripe.products.create(
      { name: input.name, metadata: input.metadata },
      { idempotencyKey: `product_${input.key}` },
    );
    return product.id;
  }

  // --- Plans ----------------------------------------------------------------------
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    include: { tier: true, prices: { include: { city: true } } },
    orderBy: [{ tier: { sortOrder: "asc" } }, { period: "asc" }],
  });
  for (const plan of plans) {
    const paidPrices = plan.prices.filter((p) => p.amountCents > 0);
    if (paidPrices.length === 0) {
      log(`plan ${plan.name}: free — no Stripe objects`);
      result.skipped++;
      continue;
    }
    const productId = await ensureProduct({
      key: `plan_${plan.id}`,
      currentProductId: plan.stripeProductId,
      name: `SIAPP ${plan.name}`,
      metadata: { siappPlanId: plan.id, tier: plan.tier.code, period: plan.period },
    });
    if (productId && productId !== plan.stripeProductId) {
      await prisma.plan.update({ where: { id: plan.id }, data: { stripeProductId: productId } });
    }
    for (const price of paidPrices) {
      const priceId = await ensurePrice({
        key: `planprice_${price.id}`,
        productId: productId ?? "(new product)", // null only in a dry run
        currentPriceId: price.stripePriceId,
        amountCents: price.amountCents,
        currency: price.currency,
        recurring: recurringFor(plan.period),
        metadata: { siappPlanPriceId: price.id, siappPlanId: plan.id, cityId: price.cityId, city: price.city.name },
      });
      if (priceId && priceId !== price.stripePriceId) {
        await prisma.planPrice.update({ where: { id: price.id }, data: { stripePriceId: priceId } });
      }
    }
  }

  // --- Key packs -----------------------------------------------------------------
  const packs = await prisma.keyPack.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  for (const pack of packs) {
    const productId = await ensureProduct({
      key: `pack_${pack.id}`,
      currentProductId: pack.stripeProductId,
      name: `SIAPP ${pack.name}`,
      metadata: { siappKeyPackId: pack.id, keys: String(pack.keys) },
    });
    if (productId && productId !== pack.stripeProductId) {
      await prisma.keyPack.update({ where: { id: pack.id }, data: { stripeProductId: productId } });
    }
    const priceId = await ensurePrice({
      key: `pack_${pack.id}`,
      productId: productId ?? "(new product)",
      currentPriceId: pack.stripePriceId,
      amountCents: pack.amountCents,
      currency: pack.currency,
      recurring: null,
      metadata: { siappKeyPackId: pack.id, keys: String(pack.keys) },
    });
    if (priceId && priceId !== pack.stripePriceId) {
      await prisma.keyPack.update({ where: { id: pack.id }, data: { stripePriceId: priceId } });
    }
  }

  return result;
}

if (require.main === module) {
  (async () => {
    const { makePrismaClient } = await import("../src/lib/db");
    const { getStripe } = await import("../src/lib/stripe");
    const prisma = makePrismaClient();
    const dryRun = process.argv.includes("--dry-run");
    try {
      const result = await syncStripePrices(prisma, getStripe(), {
        dryRun,
        log: (m) => console.log(`[stripe-sync] ${m}`),
      });
      console.log(
        `[stripe-sync] ${dryRun ? "DRY RUN — " : ""}products +${result.productsCreated} ~${result.productsUpdated}, prices +${result.pricesCreated} archived ${result.pricesArchived}, unchanged ${result.skipped}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
