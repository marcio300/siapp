/**
 * Daily job: monthly key grants for quarterly/yearly plans and the FREE tier
 * (subscriptions whose `nextGrantAt` has passed). Monthly Stripe plans are
 * granted by the invoice.paid webhook instead.
 *
 *   pnpm jobs:monthly-grants
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { runMonthlyGrants } from "../../src/domain/billing/subscriptions";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await runMonthlyGrants({ db: prisma });
    console.log(`[monthly-grants] granted ${r.granted}, skipped ${r.skipped} (past due)`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
