import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { grantPurchasedKeys } from "@/domain/keys";
import { getMembership } from "@/domain/billing";
import { openFlag } from "@/domain/fraud/flags";
import { emailReferralVested } from "./notify";
import { inviteeLabel, monthStartUtc } from "./status";

/**
 * Spec §9 + CLAUDE.md rule 5. A PENDING referral vests when
 *   1. the invitee's first paid, non-tourist period is older than
 *      `referral_vesting_days` (the Stripe refund/dispute window), and
 *   2. the invitee has at least one CHECKED_IN redemption, and
 *   3. the referrer is (still) on a paid, non-tourist plan, and
 *   4. the referrer is under `referral_monthly_cap` vested referrals this month.
 * It is REJECTED outright (and flagged for the fraud queue) on self-referral,
 * a shared device fingerprint or a shared card fingerprint. Both bonuses are
 * PURCHASED-pool grants with a per-referral reference, so a re-run can never
 * pay twice (invariant 8).
 */
export type VestOutcome = "vested" | "rejected" | "pending";

export interface VestDetail {
  outcome: VestOutcome;
  reason: string;
}

interface Opts {
  db?: PrismaClient;
  now?: Date;
}

async function sharedFingerprint(db: PrismaClient, a: string, b: string): Promise<{ device?: string; card?: string }> {
  const [devicesA, devicesB, cardsA, cardsB] = await Promise.all([
    db.device.findMany({ where: { memberId: a }, select: { fingerprint: true } }),
    db.device.findMany({ where: { memberId: b }, select: { fingerprint: true } }),
    db.paymentMethodFingerprint.findMany({ where: { memberId: a }, select: { fingerprint: true } }),
    db.paymentMethodFingerprint.findMany({ where: { memberId: b }, select: { fingerprint: true } }),
  ]);
  const setB = new Set(devicesB.map((d) => d.fingerprint));
  const device = devicesA.find((d) => setB.has(d.fingerprint))?.fingerprint;
  const cardsSetB = new Set(cardsB.map((c) => c.fingerprint));
  const card = cardsA.find((c) => cardsSetB.has(c.fingerprint))?.fingerprint;
  return { device, card };
}

/** Evaluate one referral. Idempotent: anything but PENDING returns immediately. */
export async function vestReferral(referralId: string, opts: Opts = {}): Promise<VestDetail> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const ref = await db.referral.findUnique({ where: { id: referralId }, include: { referrer: { select: { id: true, email: true, name: true } }, invitee: { select: { id: true, email: true, name: true } } } });
  if (!ref) return { outcome: "pending", reason: "not_found" };
  if (ref.status === "VESTED") return { outcome: "vested", reason: "already_vested" };
  if (ref.status === "REJECTED") return { outcome: "rejected", reason: ref.rejectedReason ?? "rejected" };

  const reject = async (reason: string, evidence: Record<string, unknown>) => {
    await db.referral.update({ where: { id: ref.id }, data: { status: "REJECTED", rejectedReason: reason } });
    await openFlag(db, ref.inviteeId, "SELF_REFERRAL", { referralId: ref.id, referrerId: ref.referrerId, reason, ...evidence }, null, now);
    return { outcome: "rejected" as const, reason };
  };

  // Hard rejections first — they don't wait for the paid period.
  if (ref.referrerId === ref.inviteeId) return reject("self_referral", {});
  const shared = await sharedFingerprint(db, ref.referrerId, ref.inviteeId);
  if (shared.device) return reject("shared_device", { fingerprint: shared.device });
  if (shared.card) return reject("shared_card", { fingerprint: shared.card });

  // 1. invitee's first paid, non-tourist period past the refund window
  const vestingDays = await getSetting("referral_vesting_days", db);
  const firstPaid = await db.subscription.findFirst({
    where: { memberId: ref.inviteeId, firstPaidAt: { not: null }, plan: { period: { not: "TOURIST_WEEK" } } },
    orderBy: { firstPaidAt: "asc" },
    select: { firstPaidAt: true },
  });
  if (!firstPaid?.firstPaidAt) return { outcome: "pending", reason: "invitee_not_paid" };
  if (firstPaid.firstPaidAt.getTime() + vestingDays * 86_400_000 > now.getTime()) return { outcome: "pending", reason: "refund_window" };

  // 2. invitee showed up at least once
  const shows = await db.redemption.count({ where: { memberId: ref.inviteeId, status: "CHECKED_IN" } });
  if (shows === 0) return { outcome: "pending", reason: "invitee_no_show_yet" };

  // 3. referrer still paid, non-tourist
  const referrer = await getMembership(ref.referrerId, { db });
  if (!referrer.isPaid || referrer.isTourist) return { outcome: "pending", reason: "referrer_not_paid" };

  // 4. monthly cap
  const cap = await getSetting("referral_monthly_cap", db);
  const vestedThisMonth = await db.referral.count({ where: { referrerId: ref.referrerId, status: "VESTED", vestedAt: { gte: monthStartUtc(now) } } });
  if (vestedThisMonth >= cap) return { outcome: "pending", reason: "monthly_cap" };

  const bonus = await getSetting("referral_bonus_keys", db);
  const vested = await db.$transaction(async (tx) => {
    const flipped = await tx.referral.updateMany({ where: { id: ref.id, status: "PENDING" }, data: { status: "VESTED", vestedAt: now } });
    if (flipped.count === 0) return false;
    await grantPurchasedKeys(ref.referrerId, bonus, "REFERRAL_BONUS", { reference: `referral:${ref.id}:referrer`, note: `Referral bonus — ${inviteeLabel(ref.invitee)}` }, { db: tx, now });
    await grantPurchasedKeys(ref.inviteeId, bonus, "REFERRAL_BONUS", { reference: `referral:${ref.id}:invitee`, note: "Referral bonus — welcome" }, { db: tx, now });
    return true;
  });
  if (!vested) return { outcome: "vested", reason: "already_vested" };
  await emailReferralVested({ to: ref.referrer.email, keys: bonus, role: "referrer", otherLabel: inviteeLabel(ref.invitee) });
  await emailReferralVested({ to: ref.invitee.email, keys: bonus, role: "invitee", otherLabel: inviteeLabel(ref.referrer) });
  return { outcome: "vested", reason: "vested" };
}

/** Daily job: evaluate every PENDING referral. */
export async function vestReferrals(opts: Opts & { referrerId?: string } = {}): Promise<{ vested: number; rejected: number; pending: number }> {
  const db = opts.db ?? defaultPrisma;
  const pending = await db.referral.findMany({ where: { status: "PENDING", ...(opts.referrerId ? { referrerId: opts.referrerId } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const out = { vested: 0, rejected: 0, pending: 0 };
  for (const r of pending) {
    const d = await vestReferral(r.id, opts);
    out[d.outcome]++;
  }
  return out;
}
