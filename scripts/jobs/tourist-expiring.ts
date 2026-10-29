/**
 * Hourly: tourist-expiring (spec §16). Same function Vercel Cron calls at /api/cron/tourist-expiring.
 *   pnpm jobs:tourist-expiring
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { sendTouristExpiringNotices } from "../../src/domain/notifications/jobs";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await sendTouristExpiringNotices({ db: prisma });
    console.log(`[tourist-expiring] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
