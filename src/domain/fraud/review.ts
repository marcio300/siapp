import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Backoffice fraud queue actions. Approving/denying a flag that is linked to
 * a HELD redemption releases or denies that redemption; releasing keys for a
 * DENIED redemption is Phase 5's job (it owns redemption money/keys flow).
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
    const otherOpen = await db.fraudFlag.count({ where: { redemptionId: flag.redemptionId, status: "OPEN" } });
    if (decision === "DENIED") {
      await db.redemption.updateMany({ where: { id: flag.redemptionId, status: "HELD" }, data: { status: "DENIED" } });
    } else if (otherOpen === 0) {
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
