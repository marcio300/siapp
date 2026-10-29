/**
 * Hourly: keys-expiring (spec §16). Same function Vercel Cron calls at /api/cron/keys-expiring.
 *   pnpm jobs:keys-expiring
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { sendKeysExpiringNotices } from "../../src/domain/notifications/jobs";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await sendKeysExpiringNotices({ db: prisma });
    console.log(`[keys-expiring] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
