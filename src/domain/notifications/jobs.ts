import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getBalance } from "@/domain/keys";
import { emailEventReminder, emailKeysExpiring, emailTouristExpiring } from "./emails";
import { notifyOnce } from "./log";

interface Opts {
  db?: PrismaClient;
  now?: Date;
}
const HOUR = 3_600_000;
export const REMINDER_HOURS_BEFORE = 25;
export const KEYS_EXPIRING_DAYS = 3;
export const TOURIST_EXPIRING_HOURS = 24;

/** Hourly: ACTIVE redemptions for events starting within 25 h — one reminder each, with the cancellation cutoff. */
export async function sendEventReminders(opts: Opts = {}): Promise<{ sent: number; considered: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const rows = await db.redemption.findMany({
    where: { status: "ACTIVE", event: { status: "PUBLISHED", startsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_HOURS_BEFORE * HOUR) } } },
    include: { member: { select: { email: true } }, event: { include: { city: { select: { timezone: true } } } } },
  });
  let sent = 0;
  for (const r of rows) {
    const ok = await notifyOnce(
      { memberId: r.memberId, kind: "event_reminder", reference: r.id },
      () => emailEventReminder({ to: r.member.email, eventTitle: r.event.title, venue: r.event.venue, startsAt: r.event.startsAt, timezone: r.event.city.timezone, plusOneName: r.plusOneName, cancelDeadlineAt: r.cancelDeadlineAt, redemptionId: r.id, now }),
      { db, now },
    );
    if (ok) sent++;
  }
  return { sent, considered: rows.length };
}

/** Hourly: plan keys that expire within 3 days — one notice per expiry date. */
export async function sendKeysExpiringNotices(opts: Opts = {}): Promise<{ sent: number; considered: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const rows = await db.keyBalance.findMany({
    where: { planKeys: { gt: 0 }, planKeysExpireAt: { gt: now, lte: new Date(now.getTime() + KEYS_EXPIRING_DAYS * 24 * HOUR) } },
    include: { member: { select: { email: true, city: { select: { timezone: true } } } } },
  });
  let sent = 0;
  for (const b of rows) {
    const balance = await getBalance(b.memberId, { db, now });
    if (balance.planKeys <= 0 || !b.planKeysExpireAt) continue;
    const ok = await notifyOnce(
      { memberId: b.memberId, kind: "keys_expiring", reference: b.planKeysExpireAt.toISOString() },
      () => emailKeysExpiring({ to: b.member.email, keys: balance.planKeys, expiresAt: b.planKeysExpireAt!, timezone: b.member.city?.timezone ?? "Europe/Lisbon" }),
      { db, now },
    );
    if (ok) sent++;
  }
  return { sent, considered: rows.length };
}

/** Hourly: tourist passes ending within 24 h. */
export async function sendTouristExpiringNotices(opts: Opts = {}): Promise<{ sent: number; considered: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const rows = await db.subscription.findMany({
    where: { status: "ACTIVE", plan: { period: "TOURIST_WEEK" }, currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + TOURIST_EXPIRING_HOURS * HOUR) } },
    include: { member: { select: { email: true, city: { select: { timezone: true } } } } },
  });
  let sent = 0;
  for (const s of rows) {
    const balance = await getBalance(s.memberId, { db, now });
    const ok = await notifyOnce(
      { memberId: s.memberId, kind: "tourist_expiring", reference: s.id },
      () => emailTouristExpiring({ to: s.member.email, endsAt: s.currentPeriodEnd, timezone: s.member.city?.timezone ?? "Europe/Lisbon", keysLeft: balance.planKeys }),
      { db, now },
    );
    if (ok) sent++;
  }
  return { sent, considered: rows.length };
}
