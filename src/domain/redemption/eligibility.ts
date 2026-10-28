import type { Member, Offer, Prisma, PrismaClient, RedemptionStatus, TierCode } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { getBalance } from "@/domain/keys/ledger";
import { getMembership } from "@/domain/billing/subscriptions";
import { verificationStatus } from "@/domain/identity/verification";
import type { RefusalReason } from "./errors";

/**
 * Eligibility (spec §7, checks 1–5 — 6 overlap and 7 fraud run in
 * fraud.evaluate). Pure given its inputs so the event page can explain the
 * state ("opens to your tier in 23h") and `redeem` can enforce it inside the
 * locked transaction with fresh numbers.
 */
export const COUNTING: RedemptionStatus[] = ["PENDING_PAYMENT", "HELD", "ACTIVE", "CHECKED_IN"];

export interface EligibilityInput {
  now: Date;
  member: Pick<Member, "emailVerified" | "onboardedAt" | "selfieUploadedAt" | "bannedAt" | "id">;
  tierCode: TierCode;
  isPaid: boolean;
  balanceTotal: number;
  offer: Offer & { event: { status: string; startsAt: Date; publishedAt: Date | null } };
  /** Redemptions in counting statuses on this offer (all members). */
  used: number;
  /** Live waitlist claims held by OTHER members (reserved seats). */
  reservedForOthers: number;
  /** This member's counting redemptions on this offer. */
  ownCount: number;
  plusOne: boolean;
}

export type Eligibility =
  | { ok: true; keyCost: number; cashCents: number; privateSaleActive: boolean }
  | { ok: false; reason: RefusalReason; message: string; detail: Record<string, unknown> };

export function discountedPriceCents(faceValueCents: number, discountPercent: number): number {
  return Math.round(faceValueCents * (1 - discountPercent / 100));
}

export function offerCost(offer: Offer, plusOne: boolean): { keyCost: number; cashCents: number } {
  const keyCost = offer.keyCost + (plusOne ? offer.plusOneExtraKeyCost : 0);
  let cashCents = 0;
  if (offer.type === "DISCOUNT_TICKET") cashCents += discountedPriceCents(offer.faceValueCents ?? 0, offer.discountPercent ?? 0);
  if (plusOne && offer.plusOneExtraCashCents) cashCents += offer.plusOneExtraCashCents;
  return { keyCost, cashCents };
}

export function checkEligibility(i: EligibilityInput): Eligibility {
  const { offer, now } = i;
  const refuse = (reason: RefusalReason, message: string, detail: Record<string, unknown> = {}): Eligibility => ({ ok: false, reason, message, detail });

  // 1. identity
  if (i.member.bannedAt) return refuse("BANNED", "Sorry, this account is closed.");
  const v = verificationStatus(i.member);
  if (!v.canRedeem) return refuse("NOT_VERIFIED", v.selfie ? "Finish your profile first." : "Add a selfie first — it's what the door sees.", { nextStep: v.nextStep });

  // 3. open (checked before tier so the member sees the real blocker first)
  if (offer.event.status !== "PUBLISHED") return refuse("EVENT_NOT_OPEN", "This event isn't open.");
  const from = offer.redeemFrom ?? offer.event.publishedAt ?? now;
  const until = offer.redeemUntil ?? offer.event.startsAt;
  if (now < from) return refuse("OFFER_NOT_OPEN", "Not open yet.", { opensAt: from.toISOString() });
  if (now > until) return refuse("OFFER_CLOSED", "Redemptions for this one have closed.", { closedAt: until.toISOString() });

  // 2. tier + private sale
  if (i.tierCode === "FREE" && !offer.openToFree) return refuse("TIER_NOT_ALLOWED", "Sorry, this one is for paid members.", { minTier: "SOCIAL" });
  const privateSaleActive = offer.privateSaleTiers.length > 0 && (!offer.privateSaleOpensAt || now < offer.privateSaleOpensAt);
  if (privateSaleActive && !offer.privateSaleTiers.includes(i.tierCode)) {
    return refuse("PRIVATE_SALE", `Sorry, this one opens to ${offer.privateSaleTiers.join(" and ")} members first.`, {
      opensAt: offer.privateSaleOpensAt?.toISOString() ?? null,
      tiers: offer.privateSaleTiers,
    });
  }

  // +1
  if (i.plusOne && !offer.plusOneAllowed) return refuse("PLUS_ONE_NOT_ALLOWED", "No +1 on this one.");

  // 4. capacity
  if (offer.allocationType === "CAPPED" && offer.capacity !== null) {
    if (i.used >= offer.capacity) return refuse("SOLD_OUT", "Sorry, it's full.", { capacity: offer.capacity });
    if (i.used + i.reservedForOthers >= offer.capacity) return refuse("WAITLIST_ONLY", "The last spots are reserved for the waitlist.", { capacity: offer.capacity });
  }

  // 5. keys + max per member
  if (i.ownCount >= offer.maxPerMember) return refuse("MAX_PER_MEMBER", offer.maxPerMember === 1 ? "You already have this one." : `Max ${offer.maxPerMember} per member.`, { max: offer.maxPerMember });
  const cost = offerCost(offer, i.plusOne);
  if (i.balanceTotal < cost.keyCost) return refuse("INSUFFICIENT_KEYS", `You need ${cost.keyCost} keys and have ${i.balanceTotal}.`, { needed: cost.keyCost, have: i.balanceTotal });

  return { ok: true, ...cost, privateSaleActive };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Live waitlist claims (NOTIFIED, claim window open) reserve capacity for their holders. */
export async function reservedSeats(db: Db, offerId: string, now: Date, exceptMemberId?: string): Promise<number> {
  return db.waitlistEntry.count({
    where: { offerId, status: "NOTIFIED", claimBy: { gt: now }, ...(exceptMemberId ? { memberId: { not: exceptMemberId } } : {}) },
  });
}

/** Gather everything checkEligibility needs (outside a transaction — for pages). */
export async function explainEligibility(memberId: string, offerId: string, opts: { db?: PrismaClient; now?: Date; plusOne?: boolean } = {}): Promise<Eligibility> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const [member, offer, membership, balance] = await Promise.all([
    db.member.findUniqueOrThrow({ where: { id: memberId } }),
    db.offer.findUniqueOrThrow({ where: { id: offerId }, include: { event: true } }),
    getMembership(memberId, { db, now }),
    getBalance(memberId, { db, now }),
  ]);
  const [used, reservedForOthers, ownCount] = await Promise.all([
    db.redemption.count({ where: { offerId, status: { in: COUNTING } } }),
    reservedSeats(db, offerId, now, memberId),
    db.redemption.count({ where: { offerId, memberId, status: { in: COUNTING } } }),
  ]);
  return checkEligibility({ now, member, tierCode: membership.tierCode, isPaid: membership.isPaid, balanceTotal: balance.total, offer, used, reservedForOthers, ownCount, plusOne: opts.plusOne ?? false });
}

export async function cancellationWindowHours(offer: Pick<Offer, "cancellationWindowHours">, db: Db = defaultPrisma): Promise<number> {
  return offer.cancellationWindowHours ?? (await getSetting("cancellation_window_hours", db));
}
