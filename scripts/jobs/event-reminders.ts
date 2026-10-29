/**
 * Hourly: event-reminders (spec §16). Same function Vercel Cron calls at /api/cron/event-reminders.
 *   pnpm jobs:event-reminders
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { sendEventReminders } from "../../src/domain/notifications/jobs";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await sendEventReminders({ db: prisma });
    console.log(`[event-reminders] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
