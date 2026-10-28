/**
 * Nightly job: recompute key balances from the ledger and report cache
 * mismatches (docs/DATA_MODEL.md). Exit code 1 when any mismatch is found so
 * the cron run shows red.
 *
 *   pnpm exec tsx scripts/jobs/reconcile-balances.ts          # report only
 *   pnpm exec tsx scripts/jobs/reconcile-balances.ts --fix    # rewrite the cache from the ledger
 */
import "dotenv/config";
import { makePrismaClient } from "../../src/lib/db";
import { reconcileBalances } from "../../src/domain/keys/reconcile";

async function main() {
  const prisma = makePrismaClient();
  const fix = process.argv.includes("--fix");
  try {
    const report = await reconcileBalances({ db: prisma, fix });
    console.log(`[reconcile-balances] checked ${report.membersChecked} members`);
    for (const m of report.mismatches) {
      console.log(`[reconcile-balances] MISMATCH member=${m.memberId} pool=${m.pool} ledger=${m.ledger} cache=${m.cache}`);
    }
    if (fix) console.log(`[reconcile-balances] fixed ${report.fixed} cache rows`);
    if (report.mismatches.length === 0) console.log("[reconcile-balances] OK — cache matches ledger");
    else if (!fix) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
