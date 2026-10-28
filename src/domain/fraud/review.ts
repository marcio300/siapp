import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Backoffice fraud queue actions. Owner decision 2026-10-28: ONE approval
 * releases a HELD redemption and closes every other open flag on it as
 * APPROVED (noted as approved alongside the reviewed flag); any denial denies
 * the redemption. Releasing keys for a DENIED redemption is Phase 5's job.
 */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export async function reviewFlag(
  flagId: string,
  decision: "APPROVED" | "DENIED",
  input: { staffId: string; note?: string },
  opts: { db?: PrismaClient; now?: Date } = {},
) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const flag = await db.fraudFlag.findUnique({ where: { id: flagId } });
  if (!flag) throw new ReviewError("Flag not found");
  if (flag.status !== "OPEN") throw new ReviewError(`Flag already ${flag.status.toLowerCase()}`);
  const updated = await db.fraudFlag.update({
    where: { id: flag.id },
    data: { status: decision, reviewedById: input.staffId, reviewedAt: now, reviewNote: input.note?.trim() || null },
  });
  if (flag.redemptionId) {
    if (decision === "DENIED") {
      await db.redemption.updateMany({ where: { id: flag.redemptionId, status: "HELD" }, data: { status: "DENIED" } });
    } else {
      await db.fraudFlag.updateMany({
        where: { redemptionId: flag.redemptionId, status: "OPEN" },
        data: { status: "APPROVED", reviewedById: input.staffId, reviewedAt: now, reviewNote: `approved with ${flag.rule} flag ${flag.id}` },
      });
      await db.redemption.updateMany({ where: { id: flag.redemptionId, status: "HELD" }, data: { status: "ACTIVE" } });
    }
  }
  return updated;
}

/** Ban: closes every open flag as DENIED, denies HELD redemptions, blocks sign-in (auth signIn callback). */
export async function banMember(memberId: string, input: { staffId: string; reason: string }, opts: { db?: PrismaClient; now?: Date } = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ReviewError("A reason is required");
  await db.member.update({ where: { id: memberId }, data: { bannedAt: now, banReason: reason } });
  await db.fraudFlag.updateMany({
    where: { memberId, status: "OPEN" },
    data: { status: "DENIED", reviewedById: input.staffId, reviewedAt: now, reviewNote: `banned: ${reason}` },
  });
  await db.redemption.updateMany({ where: { memberId, status: "HELD" }, data: { status: "DENIED" } });
  await db.session.deleteMany({ where: { userId: memberId } });
}

export async function unbanMember(memberId: string, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  await db.member.update({ where: { id: memberId }, data: { bannedAt: null, banReason: null } });
}
