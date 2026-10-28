/**
 * Hourly: ended events → ACTIVE redemptions become NO_SHOW (keys forfeited), attendance updated, event FINISHED.
 *   pnpm jobs:mark-no-shows
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { markNoShows } from "../../src/domain/redemption/lifecycle";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await markNoShows({ db: prisma });
    console.log(`[mark-no-shows] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
