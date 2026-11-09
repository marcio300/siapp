/**
 * Every minute: deliver pending signed messages to producers' EventOS (contract §4), retrying with backoff.
 *   pnpm jobs:partner-outbox
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { flushOutbound } from "../../src/domain/partners-api/outbox";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await flushOutbound({ db: prisma });
    console.log(`[partner-outbox] ${JSON.stringify(r)}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
