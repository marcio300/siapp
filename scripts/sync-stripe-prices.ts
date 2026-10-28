/**
 * CLI for src/domain/billing/stripe-prices.ts:
 *
 *   pnpm stripe:sync-prices            # needs DATABASE_URL + STRIPE_SECRET_KEY
 *   pnpm stripe:sync-prices --dry-run  # print what would change
 */
import "dotenv/config";
import { makePrismaClient } from "../src/lib/db";
import { getStripe } from "../src/lib/stripe";
import { syncStripePrices } from "../src/domain/billing/stripe-prices";

(async () => {
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
