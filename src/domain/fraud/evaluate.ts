import type { FraudRule, Prisma, PrismaClient, RedemptionStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { openFlag } from "./flags";

/**
 * Fraud evaluation before a redemption (spec §7 steps 6–7, §10).
 *
 * - REJECT: the OVERLAP rule (owner decision 2026-10-28) — a live redemption
 *   for another event starting within ±overlap_tolerance_hours is a hard
 *   eligibility failure (spec §7 item 6). No flag is written; the member gets
 *   the reason straight away. Further apart than the tolerance → allowed.
 * - REVIEW: every other rule that fires is written as an OPEN FraudFlag with
 *   evidence; the caller creates a HELD redemption (Phase 5) and passes its id
 *   so the flags link to it.
 * - ALLOW: nothing fired.
 *
 * Review rules (all thresholds from Settings):
 * - DEVICE_MAX_ACCOUNTS   a fingerprint of this member is shared by more than device_max_accounts members
 * - VELOCITY_FIRST_HOUR   account < 1 h old and already ≥ velocity_first_hour_max redemptions
 * - VELOCITY_PRIVATE_SALE account < 24 h old and already ≥ velocity_private_sale_first_day_max private-sale
 *                         redemptions, and this offer is a private sale
 * - SAME_CARD             a card fingerprint of this member is shared by more than same_card_max_accounts members
 * - SELF_REFERRAL         reserved for Phase 7 (referrals)
 */
export type FraudDecision = "ALLOW" | "REVIEW" | "REJECT";

export interface FiredRule {
  rule: FraudRule;
  evidence: Record<string, unknown>;
}

export interface FraudEvaluation {
  decision: FraudDecision;
  /** Review rules that fired (each has an OPEN FraudFlag). */
  fired: FiredRule[];
  /** Hard-reject rules that fired (no flag; show the reason to the member). */
  rejected: FiredRule[];
}

const LIVE_REDEMPTION: RedemptionStatus[] = ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"];

export async function evaluate(
  memberId: string,
  offerId: string,
  opts: { db?: PrismaClient | Prisma.TransactionClient; now?: Date; redemptionId?: string | null } = {},
): Promise<FraudEvaluation> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const fired: FiredRule[] = [];
  const rejected: FiredRule[] = [];

  const [member, offer] = await Promise.all([
    db.member.findUniqueOrThrow({ where: { id: memberId } }),
    db.offer.findUniqueOrThrow({ where: { id: offerId }, include: { event: true } }),
  ]);
  const [deviceMax, velocityHourMax, velocityPrivateMax, overlapHours, cardMax] = await Promise.all([
    getSetting("device_max_accounts"),
    getSetting("velocity_first_hour_max"),
    getSetting("velocity_private_sale_first_day_max"),
    getSetting("overlap_tolerance_hours"),
    getSetting("same_card_max_accounts"),
  ]);
  const accountAgeMs = now.getTime() - member.createdAt.getTime();

  // DEVICE_MAX_ACCOUNTS
  const devices = await db.device.findMany({ where: { memberId }, select: { fingerprint: true } });
  for (const d of devices) {
    const accounts = await db.device.count({ where: { fingerprint: d.fingerprint } });
    if (accounts > deviceMax) {
      fired.push({ rule: "DEVICE_MAX_ACCOUNTS", evidence: { fingerprint: d.fingerprint, accountsOnDevice: accounts, max: deviceMax } });
      break;
    }
  }

  // VELOCITY_FIRST_HOUR
  if (accountAgeMs < 3_600_000) {
    const count = await db.redemption.count({ where: { memberId, status: { in: LIVE_REDEMPTION }, ...(opts.redemptionId ? { id: { not: opts.redemptionId } } : {}) } });
    if (count >= velocityHourMax) {
      fired.push({ rule: "VELOCITY_FIRST_HOUR", evidence: { redemptionsInFirstHour: count, max: velocityHourMax, accountAgeMinutes: Math.round(accountAgeMs / 60_000) } });
    }
  }

  // VELOCITY_PRIVATE_SALE
  const isPrivateSale = offer.privateSaleTiers.length > 0;
  if (isPrivateSale && accountAgeMs < 86_400_000) {
    const count = await db.redemption.count({
      where: {
        memberId,
        status: { in: LIVE_REDEMPTION },
        offer: { privateSaleTiers: { isEmpty: false } },
        ...(opts.redemptionId ? { id: { not: opts.redemptionId } } : {}),
      },
    });
    if (count >= velocityPrivateMax) {
      fired.push({ rule: "VELOCITY_PRIVATE_SALE", evidence: { privateSaleRedemptionsInFirstDay: count, max: velocityPrivateMax } });
    }
  }

  // OVERLAP
  const toleranceMs = overlapHours * 3_600_000;
  const overlapping = await db.redemption.findFirst({
    where: {
      memberId,
      status: { in: LIVE_REDEMPTION },
      eventId: { not: offer.eventId },
      ...(opts.redemptionId ? { id: { not: opts.redemptionId } } : {}),
      event: {
        startsAt: { gte: new Date(offer.event.startsAt.getTime() - toleranceMs), lte: new Date(offer.event.startsAt.getTime() + toleranceMs) },
      },
    },
    include: { event: { select: { id: true, title: true, startsAt: true } } },
  });
  if (overlapping) {
    rejected.push({
      rule: "OVERLAP",
      evidence: {
        otherEventId: overlapping.event.id,
        otherEventTitle: overlapping.event.title,
        otherStartsAt: overlapping.event.startsAt.toISOString(),
        thisStartsAt: offer.event.startsAt.toISOString(),
        toleranceHours: overlapHours,
      },
    });
  }

  // SAME_CARD
  const cards = await db.paymentMethodFingerprint.findMany({ where: { memberId }, select: { fingerprint: true, last4: true } });
  for (const c of cards) {
    const accounts = await db.paymentMethodFingerprint.count({ where: { fingerprint: c.fingerprint } });
    if (accounts > cardMax) {
      fired.push({ rule: "SAME_CARD", evidence: { last4: c.last4, accountsOnCard: accounts, max: cardMax } });
      break;
    }
  }

  for (const f of fired) await openFlag(db, memberId, f.rule, f.evidence, opts.redemptionId ?? null, now);
  const decision: FraudDecision = rejected.length > 0 ? "REJECT" : fired.length > 0 ? "REVIEW" : "ALLOW";
  return { decision, fired, rejected };
}
