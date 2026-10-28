import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { openFlag } from "./flags";

/**
 * Device fingerprints (spec §10): upserted on every login/app load. A
 * fingerprint shared by more than `device_max_accounts` members flags the
 * member (DEVICE_MAX_ACCOUNTS) for review.
 */
export async function recordDevice(
  memberId: string,
  fingerprint: string,
  userAgent: string | null,
  opts: { db?: PrismaClient; now?: Date } = {},
): Promise<{ sharedWith: number; flagged: boolean }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const fp = fingerprint.trim().slice(0, 128);
  if (!fp) return { sharedWith: 0, flagged: false };
  await db.device.upsert({
    where: { memberId_fingerprint: { memberId, fingerprint: fp } },
    update: { lastSeenAt: now, userAgent: userAgent?.slice(0, 512) ?? undefined },
    create: { memberId, fingerprint: fp, userAgent: userAgent?.slice(0, 512) ?? null, firstSeenAt: now, lastSeenAt: now },
  });
  const sharedWith = (await db.device.count({ where: { fingerprint: fp, memberId: { not: memberId } } }));
  const max = await getSetting("device_max_accounts");
  const flagged = sharedWith + 1 > max;
  if (flagged) {
    await openFlag(
      db,
      memberId,
      "DEVICE_MAX_ACCOUNTS",
      { fingerprint: fp, accountsOnDevice: sharedWith + 1, max },
      null,
      now,
    );
  }
  return { sharedWith, flagged };
}

/** Members sharing any of this member's fingerprints (backoffice view). */
export async function deviceOverlap(memberId: string, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const devices = await db.device.findMany({ where: { memberId }, orderBy: { lastSeenAt: "desc" } });
  const result = [];
  for (const d of devices) {
    const others = await db.device.findMany({
      where: { fingerprint: d.fingerprint, memberId: { not: memberId } },
      include: { member: { select: { id: true, email: true } } },
    });
    result.push({ device: d, sharedWith: others.map((o) => o.member) });
  }
  return result;
}
