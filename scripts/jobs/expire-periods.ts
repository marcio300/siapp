/**
 * Hourly job: expire plan keys for periods that ended and mark tourist
 * passes EXPIRED (members drop back to FREE).
 *
 *   pnpm jobs:expire-periods
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { runExpirePeriods } from "../../src/domain/billing/subscriptions";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await runExpirePeriods({ db: prisma });
    console.log(`[expire-periods] expired keys for ${r.expiredKeys} subscriptions, ${r.expiredPasses} tourist passes ended`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
