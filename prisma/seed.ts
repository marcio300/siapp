/**
 * Seed: city Lisbon, tiers, plans × periods (+ tourist week), key packs, global
 * settings and one ADMIN staff user from env (SEED_ADMIN_EMAIL / SEED_ADMIN_NAME,
 * optional SEED_MEMBER_EMAIL).
 *
 * Run: pnpm db:seed   (idempotent — safe to re-run; never overwrites edited values)
 */
import "dotenv/config";
import { makePrismaClient } from "../src/lib/db";
import { runSeed } from "./seed-data";

const prisma = makePrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  if (!adminEmail) throw new Error("SEED_ADMIN_EMAIL is not set (see .env.example)");
  const summary = await runSeed(prisma, {
    adminEmail,
    adminName: process.env.SEED_ADMIN_NAME,
    memberEmail: process.env.SEED_MEMBER_EMAIL || undefined,
    log: (m) => console.log(`[seed] ${m}`),
  });
  console.log(`[seed] done — ${summary.plans} plans, ${summary.keyPacks} packs, ${summary.settings} settings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
