import type { FraudRule, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One OPEN flag per (member, rule, redemption) — re-evaluations update the
 * evidence instead of piling up duplicates in the queue.
 */
export async function openFlag(
  db: Db,
  memberId: string,
  rule: FraudRule,
  evidence: Record<string, unknown>,
  redemptionId: string | null,
  now: Date,
) {
  const existing = await db.fraudFlag.findFirst({
    where: { memberId, rule, status: "OPEN", redemptionId: redemptionId ?? null },
  });
  if (existing) {
    return db.fraudFlag.update({ where: { id: existing.id }, data: { evidence: evidence as Prisma.InputJsonValue } });
  }
  return db.fraudFlag.create({
    data: { memberId, rule, evidence: evidence as Prisma.InputJsonValue, redemptionId, createdAt: now },
  });
}
