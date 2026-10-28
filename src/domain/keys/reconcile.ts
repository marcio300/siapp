import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Nightly reconciliation (docs/DATA_MODEL.md): recompute every member's
 * per-pool balance from the ledger and compare with the KeyBalance cache.
 * The ledger is the truth; `fix` rewrites the cache to match. Expiry dates
 * aren't derivable from sums, so only the key counts are checked.
 */
export interface BalanceMismatch {
  memberId: string;
  pool: "PLAN" | "PURCHASED";
  ledger: number;
  cache: number;
}

export interface ReconcileReport {
  membersChecked: number;
  mismatches: BalanceMismatch[];
  fixed: number;
}

export async function reconcileBalances(
  opts: { db?: PrismaClient; fix?: boolean } = {},
): Promise<ReconcileReport> {
  const db = opts.db ?? defaultPrisma;
  const sums = await db.keyTransaction.groupBy({
    by: ["memberId", "pool"],
    _sum: { amount: true },
  });
  const caches = await db.keyBalance.findMany();

  const ledger = new Map<string, { PLAN: number; PURCHASED: number }>();
  for (const s of sums) {
    const entry = ledger.get(s.memberId) ?? { PLAN: 0, PURCHASED: 0 };
    entry[s.pool] = s._sum.amount ?? 0;
    ledger.set(s.memberId, entry);
  }
  const cacheByMember = new Map(caches.map((c) => [c.memberId, c]));
  const memberIds = new Set([...ledger.keys(), ...cacheByMember.keys()]);

  const mismatches: BalanceMismatch[] = [];
  for (const memberId of memberIds) {
    const l = ledger.get(memberId) ?? { PLAN: 0, PURCHASED: 0 };
    const c = cacheByMember.get(memberId);
    const cachePlan = c?.planKeys ?? 0;
    const cachePurchased = c?.purchasedKeys ?? 0;
    if (l.PLAN !== cachePlan) mismatches.push({ memberId, pool: "PLAN", ledger: l.PLAN, cache: cachePlan });
    if (l.PURCHASED !== cachePurchased) {
      mismatches.push({ memberId, pool: "PURCHASED", ledger: l.PURCHASED, cache: cachePurchased });
    }
  }

  let fixed = 0;
  if (opts.fix) {
    for (const memberId of new Set(mismatches.map((m) => m.memberId))) {
      const l = ledger.get(memberId) ?? { PLAN: 0, PURCHASED: 0 };
      await db.keyBalance.upsert({
        where: { memberId },
        update: { planKeys: l.PLAN, purchasedKeys: l.PURCHASED },
        create: { memberId, planKeys: l.PLAN, purchasedKeys: l.PURCHASED },
      });
      fixed++;
    }
  }

  return { membersChecked: memberIds.size, mismatches, fixed };
}
