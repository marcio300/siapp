/**
 * Daily job: delete tourist ID photos older than 30 days (spec §10).
 *   pnpm jobs:purge-id-photos
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { purgeIdPhotos } from "../../src/domain/identity/photos";

(async () => {
  const prisma = makePrismaClient();
  try {
    const r = await purgeIdPhotos({ db: prisma });
    console.log(`[purge-id-photos] purged ${r.purged}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
