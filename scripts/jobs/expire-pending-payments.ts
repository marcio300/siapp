/**
 * Every 5 min: unpaid discounted-ticket holds past their window → EXPIRED, keys refunded, seat offered to the waitlist.
 *   pnpm jobs:expire-pending-payments
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { expirePendingPayments } from "../../src/domain/redemption/lifecycle";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await expirePendingPayments({ db: prisma });
    console.log(`[expire-pending-payments] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
