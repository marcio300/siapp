/**
 * Hourly: FINISHED events without a settlement → Settlement + lines from scanned discounted tickets, statement emailed.
 *   pnpm jobs:settle-events
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { settleEvents } from "../../src/domain/settlement/settle";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await settleEvents({ db: prisma });
    console.log(`[settle-events] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
