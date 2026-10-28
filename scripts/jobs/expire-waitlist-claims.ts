/**
 * Every 5 min: waitlist claims that ran out → EXPIRED, next in line notified.
 *   pnpm jobs:expire-waitlist-claims
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { expireWaitlistClaims } from "../../src/domain/redemption/lifecycle";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await expireWaitlistClaims({ db: prisma });
    console.log(`[expire-waitlist-claims] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
