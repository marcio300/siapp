/**
 * Daily: evaluate PENDING referrals — vest (bonus keys to both sides), reject (flagged) or keep waiting.
 *   pnpm jobs:vest-referrals
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { vestReferrals } from "../../src/domain/referrals/vesting";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await vestReferrals({ db: prisma });
    console.log(`[vest-referrals] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
