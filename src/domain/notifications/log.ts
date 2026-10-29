import type { Prisma, PrismaClient } from "@prisma/client";
import { Prisma as PrismaNs } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

export type NotificationKind = "welcome" | "plan_keys_granted" | "keys_expiring" | "event_reminder" | "no_show" | "payment_failed" | "tourist_expiring";

/**
 * Send at most once per (member, kind, reference). The log row is claimed
 * first (unique index — a concurrent run or a webhook retry loses the race and
 * skips), then the email goes out; a failed send releases the claim so the
 * next run retries. Never throws: notifications are best-effort.
 */
export async function notifyOnce(
  key: { memberId: string; kind: NotificationKind; reference: string },
  send: () => Promise<void>,
  opts: { db?: PrismaClient | Prisma.TransactionClient; now?: Date } = {},
): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  let row;
  try {
    row = await db.notificationLog.create({ data: { ...key, createdAt: opts.now ?? new Date() } });
  } catch (e) {
    if (e instanceof PrismaNs.PrismaClientKnownRequestError && e.code === "P2002") return false;
    console.error("notification log failed:", e);
    return false;
  }
  try {
    await send();
    await db.notificationLog.update({ where: { id: row.id }, data: { sentAt: opts.now ?? new Date() } });
    return true;
  } catch (e) {
    console.error(`email ${key.kind} failed:`, e);
    await db.notificationLog.delete({ where: { id: row.id } }).catch(() => undefined);
    return false;
  }
}
