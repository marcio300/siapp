import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { getBalance, spendKeys } from "@/domain/keys/ledger";
import { getMembership } from "@/domain/billing/subscriptions";
import { evaluate } from "@/domain/fraud/evaluate";
import { COUNTING, cancellationWindowHours, checkEligibility, reservedSeats } from "./eligibility";
import { RedemptionError } from "./errors";
import { emailRedemptionConfirmed } from "./notify";
import { issueTicket } from "./tickets";

/**
 * redeem(memberId, offerId, { plusOneName }) — spec §7, CLAUDE.md rule 3.
 *
 * ONE transaction: lock the offer row (SELECT … FOR UPDATE), run every
 * eligibility check with fresh counts, run fraud.evaluate, spend the keys
 * (the ledger joins this transaction and locks KeyBalance), create the
 * redemption and, when it is immediately ACTIVE, its ticket. The row lock is
 * what serialises competing members (CLAUDE.md rule 3): under READ COMMITTED
 * every statement after the lock sees the rows committed by the member who
 * held it before us, so the capacity count is exact. SERIALIZABLE would add
 * nothing but spurious aborts for the members queued behind the lock.
 * Outcomes:
 *
 * - ACTIVE          free/guest-list offer, fraud ALLOW → ticket issued, email
 * - PENDING_PAYMENT cash due (discounted ticket / +1 cash) → the caller
 *                   opens a Stripe Checkout; the webhook completes it; the
 *                   hold expires after `pending_payment_minutes`
 * - HELD            fraud REVIEW → counts against capacity until staff decide
 *
 * Keys are debited at creation for every outcome so a member can never
 * spend the same keys twice while a payment or a review is pending; EXPIRED
 * and DENIED refund them (see lifecycle.ts). A deadlock/serialization error
 * is retried a few times — that is Postgres telling us two members raced.
 */
export interface RedeemResult {
  redemptionId: string;
  status: "ACTIVE" | "PENDING_PAYMENT" | "HELD";
  keyCost: number;
  cashCents: number;
  fromPlan: number;
  fromPurchased: number;
  ticketId: string | null;
  paymentExpiresAt: Date | null;
}

export async function redeem(
  memberId: string,
  offerId: string,
  input: { plusOneName?: string | null } = {},
  opts: { db?: PrismaClient; now?: Date; retries?: number } = {},
): Promise<RedeemResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const plusOneName = input.plusOneName?.trim() || null;
  const retries = opts.retries ?? 5;
  const pendingMinutes = await getSetting("pending_payment_minutes");

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await db.$transaction(
        async (tx) => {
          // Rule 3: lock the offer so capacity is checked and written under one lock.
          const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Offer" WHERE id = ${offerId} FOR UPDATE`;
          if (locked.length === 0) throw new RedemptionError("NOT_FOUND", "Offer not found");

          // Everything on `tx` (and sequential): a second pool connection
          // inside a held transaction deadlocks the pool under a burst.
          const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, include: { city: true } });
          const offer = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, include: { event: { include: { city: true } } } });
          const membership = await getMembership(memberId, { db: tx, now });
          const balance = await getBalance(memberId, { db: tx, now });
          const used = await tx.redemption.count({ where: { offerId, status: { in: COUNTING } } });
          const reservedForOthers = await reservedSeats(tx, offerId, now, memberId);
          const ownCount = await tx.redemption.count({ where: { offerId, memberId, status: { in: COUNTING } } });
          const elig = checkEligibility({ now, member, tierCode: membership.tierCode, isPaid: membership.isPaid, balanceTotal: balance.total, offer, used, reservedForOthers, ownCount, plusOne: !!plusOneName });
          if (!elig.ok) throw new RedemptionError(elig.reason, elig.message, elig.detail);

          // 6 + 7: overlap (hard refuse) and fraud review.
          const fraud = await evaluate(memberId, offerId, { db: tx, now });
          if (fraud.decision === "REJECT") {
            const r = fraud.rejected[0]!;
            throw new RedemptionError("OVERLAP", `You already have a ticket for ${String(r.evidence.otherEventTitle ?? "another event")} around that time.`, r.evidence);
          }

          const windowHours = await cancellationWindowHours(offer, tx);
          const cancelDeadlineAt = new Date(offer.event.startsAt.getTime() - windowHours * 3_600_000);
          const status: "HELD" | "PENDING_PAYMENT" | "ACTIVE" = fraud.decision === "REVIEW" ? "HELD" : elig.cashCents > 0 ? "PENDING_PAYMENT" : "ACTIVE";
          const paymentExpiresAt = status === "PENDING_PAYMENT" ? new Date(now.getTime() + pendingMinutes * 60_000) : null;

          const redemption = await tx.redemption.create({
            data: { memberId, offerId, eventId: offer.eventId, status, keyCost: elig.keyCost, plusOneName, cashCents: elig.cashCents, paymentExpiresAt, cancelDeadlineAt, createdAt: now },
          });
          const spent = elig.keyCost > 0 ? await spendKeys(memberId, elig.keyCost, redemption.id, { db: tx, now }) : { fromPlan: 0, fromPurchased: 0 };
          if (fraud.decision === "REVIEW") {
            await tx.fraudFlag.updateMany({ where: { memberId, status: "OPEN", redemptionId: null, rule: { in: fraud.fired.map((f) => f.rule) } }, data: { redemptionId: redemption.id } });
          }
          // A waitlist claim that is being used is consumed.
          await tx.waitlistEntry.updateMany({ where: { offerId, memberId, status: "NOTIFIED" }, data: { status: "CLAIMED" } });

          let ticketId: string | null = null;
          if (status === "ACTIVE") {
            const ticket = await issueTicket(tx, { redemptionId: redemption.id, memberName: member.name ?? member.email, photoSnapshotUrl: member.selfieUrl, plusOneName });
            ticketId = ticket.id;
          }
          return { redemption, member, offer, spent, ticketId, status };
        },
        // maxWait covers queueing for a pool connection behind a burst (a
        // private sale opening); timeout covers the lock wait + the work.
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 30_000, timeout: 30_000 },
      );

      if (result.status === "ACTIVE") {
        await emailRedemptionConfirmed({
          to: result.member.email,
          eventTitle: result.offer.event.title,
          startsAt: result.offer.event.startsAt,
          timezone: result.offer.event.city.timezone,
          offerName: result.offer.name,
          keyCost: result.redemption.keyCost,
          cashCents: result.redemption.cashCents,
          plusOneName,
          redemptionId: result.redemption.id,
          cancelDeadlineAt: result.redemption.cancelDeadlineAt,
        });
      }
      return {
        redemptionId: result.redemption.id,
        status: result.status,
        keyCost: result.redemption.keyCost,
        cashCents: result.redemption.cashCents,
        fromPlan: result.spent.fromPlan,
        fromPurchased: result.spent.fromPurchased,
        ticketId: result.ticketId,
        paymentExpiresAt: result.redemption.paymentExpiresAt,
      };
    } catch (e) {
      if (isSerializationFailure(e) && attempt < retries) continue;
      throw e;
    }
  }
}

function isSerializationFailure(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === "P2034";
  const msg = e instanceof Error ? e.message : String(e);
  return /could not serialize|deadlock detected|40001|40P01/i.test(msg);
}
