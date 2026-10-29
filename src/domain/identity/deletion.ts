import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getMediaStorage } from "@/lib/media/storage";
import { billingStripe } from "@/domain/billing/stripe-client";
import { expirePlanKeys } from "@/domain/keys/ledger";
import { RedemptionError } from "@/domain/redemption/errors";
import { cancelRedemption } from "@/domain/redemption/lifecycle";
import { deleteIdPhoto } from "./photos";

export class DeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionError";
  }
}

/**
 * Account deletion (spec §15, GDPR erasure). Personal data goes; the ledger,
 * redemptions, scans and settlement lines stay attached to an anonymised row
 * because they are the financial records we must keep. Order matters: cancel
 * what can be cancelled (keys back, then forfeited with the account), stop
 * Stripe, then scrub.
 */
export async function deleteAccount(memberId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<{ cancelledRedemptions: number; forfeitedTickets: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const member = await db.member.findUnique({ where: { id: memberId } });
  if (!member) throw new DeletionError("Account not found");
  if (member.deletedAt) throw new DeletionError("This account is already deleted");

  // 1. Upcoming tickets: cancel where the cutoff allows; the rest are forfeited.
  const live = await db.redemption.findMany({ where: { memberId, status: { in: ["ACTIVE", "PENDING_PAYMENT", "HELD"] } }, select: { id: true } });
  let cancelledRedemptions = 0;
  let forfeitedTickets = 0;
  for (const r of live) {
    try {
      await cancelRedemption(r.id, memberId, { db, now, reason: "account deleted" });
      cancelledRedemptions++;
    } catch (e) {
      if (!(e instanceof RedemptionError && e.reason === "TOO_LATE")) console.error(`deletion: could not cancel redemption ${r.id}:`, e);
      forfeitedTickets++;
    }
  }

  // 2. Stripe: cancel the live subscription right away (no refund for the current period — terms §8).
  const subs = await db.subscription.findMany({ where: { memberId, status: { in: ["ACTIVE", "PAST_DUE"] } } });
  for (const sub of subs) {
    if (sub.stripeSubscriptionId) {
      try {
        await billingStripe().subscriptions.cancel(sub.stripeSubscriptionId);
      } catch (e) {
        console.error("stripe cancel on deletion failed:", e);
      }
    }
    await db.subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", nextGrantAt: null, cancelAtPeriodEnd: true } });
  }
  // Plan keys expire now (EXPIRY row, whatever the period end was); the purchased pool simply dies
  // with the anonymised row — no ledger movement, the sums still reconcile.
  const balance = await db.keyBalance.findUnique({ where: { memberId }, select: { planKeysExpireAt: true } });
  if (balance?.planKeysExpireAt) await expirePlanKeys(memberId, balance.planKeysExpireAt, { db, now });

  // 3. Photos and devices.
  if (member.selfieUrl) await getMediaStorage().remove(member.selfieUrl).catch(() => undefined);
  if (member.idPhotoUrl) await deleteIdPhoto(memberId, { db }).catch(() => undefined);
  await db.device.deleteMany({ where: { memberId } });
  await db.session.deleteMany({ where: { userId: memberId } });
  await db.account.deleteMany({ where: { userId: memberId } });
  await db.verificationToken.deleteMany({ where: { identifier: member.email } }).catch(() => undefined);
  await db.waitlistEntry.deleteMany({ where: { memberId, status: { in: ["WAITING", "NOTIFIED"] } } });

  // 4. Scrub the row. The email slot is freed so the person can sign up again later.
  await db.member.update({
    where: { id: memberId },
    data: {
      email: `deleted+${memberId}@deleted.siapp.invalid`,
      emailVerified: null,
      name: null,
      dateOfBirth: null,
      selfieUrl: null,
      selfieUploadedAt: null,
      idPhotoUrl: null,
      idPhotoUploadedAt: null,
      partnerClaimToken: null,
      partnerClaimTokenAt: null,
      deletedAt: now,
    },
  });
  await db.stripeCustomer.deleteMany({ where: { memberId } }).catch(() => undefined);
  return { cancelledRedemptions, forfeitedTickets };
}
