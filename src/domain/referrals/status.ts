import type { PrismaClient, ReferralStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getMembership } from "@/domain/billing";
import { getSetting } from "@/lib/settings";

/**
 * Spec §9: every member has a code, but it only works while the referrer is
 * on a paid, non-tourist plan. Partner promo periods count as paid (the tier
 * is paid, the member just isn't the one paying).
 */
export async function isReferralCodeActive(memberId: string, opts: { db?: PrismaClient } = {}): Promise<boolean> {
  const m = await getMembership(memberId, { db: opts.db });
  return m.isPaid && !m.isTourist;
}

export function referralLink(code: string): string {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/r/${code}`;
}

export interface ReferralRow {
  id: string;
  status: ReferralStatus;
  inviteeLabel: string;
  createdAt: Date;
  vestedAt: Date | null;
  rejectedReason: string | null;
}

export interface ReferralOverview {
  code: string;
  link: string;
  active: boolean;
  bonusKeys: number;
  monthlyCap: number;
  vestedThisMonth: number;
  keysEarned: number;
  counts: { pending: number; vested: number; rejected: number };
  referrals: ReferralRow[];
  /** The referral that brought this member in, if any. */
  referredBy: { code: string; status: ReferralStatus } | null;
}

/** First name + initial — the referrer sees who they brought in without seeing their email. */
export function inviteeLabel(invitee: { name: string | null; email: string }): string {
  if (invitee.name?.trim()) {
    const [first, ...rest] = invitee.name.trim().split(/\s+/);
    return rest.length ? `${first} ${rest[rest.length - 1]![0]!.toUpperCase()}.` : first!;
  }
  const [local] = invitee.email.split("@");
  return `${local!.slice(0, 2)}•••`;
}

export function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function referralOverview(memberId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<ReferralOverview> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { referralCode: true } });
  const [active, bonusKeys, monthlyCap, rows, earned, received] = await Promise.all([
    isReferralCodeActive(memberId, { db }),
    getSetting("referral_bonus_keys", db),
    getSetting("referral_monthly_cap", db),
    db.referral.findMany({ where: { referrerId: memberId }, include: { invitee: { select: { name: true, email: true } } }, orderBy: { createdAt: "desc" } }),
    db.keyTransaction.aggregate({ where: { memberId, type: "REFERRAL_BONUS" }, _sum: { amount: true } }),
    db.referral.findUnique({ where: { inviteeId: memberId }, select: { code: true, status: true } }),
  ]);
  const monthStart = monthStartUtc(now);
  return {
    code: member.referralCode,
    link: referralLink(member.referralCode),
    active,
    bonusKeys,
    monthlyCap,
    vestedThisMonth: rows.filter((r) => r.status === "VESTED" && r.vestedAt && r.vestedAt >= monthStart).length,
    keysEarned: earned._sum.amount ?? 0,
    counts: {
      pending: rows.filter((r) => r.status === "PENDING").length,
      vested: rows.filter((r) => r.status === "VESTED").length,
      rejected: rows.filter((r) => r.status === "REJECTED").length,
    },
    referrals: rows.map((r) => ({ id: r.id, status: r.status, inviteeLabel: inviteeLabel(r.invitee), createdAt: r.createdAt, vestedAt: r.vestedAt, rejectedReason: r.rejectedReason })),
    referredBy: received,
  };
}
