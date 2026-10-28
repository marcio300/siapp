import type { KeyPool, KeyTransactionType, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { InsufficientKeysError, KeysError } from "./errors";

/**
 * Keys ledger — CLAUDE.md rules 1 & 2 and docs/DATA_MODEL.md "Keys are a ledger".
 *
 * - A member's balance is the SUM of KeyTransaction rows per pool. `KeyBalance`
 *   is a read cache written in the SAME transaction as every ledger row; the
 *   nightly reconcile job (./reconcile.ts) asserts cache == ledger.
 * - Every write takes a row lock on the member's KeyBalance (SELECT … FOR
 *   UPDATE), so concurrent spends serialise and the balance can never go
 *   negative.
 * - Plan keys carry one expiry date for the whole pool (`planKeysExpireAt`).
 *   Expiry is lazy: any write that finds the date in the past first writes
 *   the EXPIRY row for the remainder, so correctness never depends on when
 *   the period-end job runs.
 * - Spend order: PLAN first, then PURCHASED. A spend that touches both pools
 *   writes one row per pool, both linked to the redemption, so a refund (or
 *   a future partial refund) is a mirror of those rows.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Run `fn` in a transaction. Given a PrismaClient, opens one; given a
 * TransactionClient (the caller already holds a transaction — e.g. the
 * redemption flow, which locks the offer first), joins it. The row lock on
 * KeyBalance is taken either way.
 */
function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db as Prisma.TransactionClient);
}

export interface Balance {
  planKeys: number;
  purchasedKeys: number;
  total: number;
  /** When the plan pool expires; null when there are no plan keys. */
  planKeysExpireAt: Date | null;
}

export interface GrantRef {
  /** Idempotency handle, unique per transaction type (e.g. "pack:cs_123", "sub:sub_1:2026-11"). */
  reference?: string;
  /** Free-text shown in the ledger. */
  note?: string;
}

export interface SpendBreakdown {
  fromPlan: number;
  fromPurchased: number;
}

export type PurchasedGrantType = Extract<
  KeyTransactionType,
  "PACK_PURCHASE" | "REFERRAL_BONUS" | "PROMO_GRANT"
>;

function assertPositiveInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new KeysError(`${what} must be a positive integer (got ${n})`);
}

interface LockedBalance {
  planKeys: number;
  purchasedKeys: number;
  planKeysExpireAt: Date | null;
  /** Plan keys the lazy rule expired while taking the lock (0 when none). */
  lazilyExpired: number;
}

/**
 * Ensure the cache row exists, lock it, and apply lazy expiry. Must be called
 * inside an interactive transaction; the lock is held until it commits.
 */
async function lockBalance(tx: Prisma.TransactionClient, memberId: string, now: Date): Promise<LockedBalance> {
  await tx.keyBalance.upsert({ where: { memberId }, update: {}, create: { memberId } });
  const rows = await tx.$queryRaw<
    { planKeys: number; purchasedKeys: number; planKeysExpireAt: Date | null }[]
  >`SELECT "planKeys", "purchasedKeys", "planKeysExpireAt" FROM "KeyBalance" WHERE "memberId" = ${memberId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new KeysError(`No KeyBalance for member ${memberId}`);
  const balance: LockedBalance = { ...row, lazilyExpired: 0 };
  if (balance.planKeysExpireAt && balance.planKeysExpireAt <= now) {
    balance.lazilyExpired = await writeExpiry(tx, memberId, balance, now, "lazy expiry on write");
  }
  return balance;
}

/** Writes the EXPIRY row for the plan remainder and zeroes the pool. Mutates `balance`. */
async function writeExpiry(
  tx: Prisma.TransactionClient,
  memberId: string,
  balance: LockedBalance,
  now: Date,
  note: string,
): Promise<number> {
  const remainder = balance.planKeys;
  if (remainder > 0) {
    await tx.keyTransaction.create({
      data: { memberId, pool: "PLAN", type: "EXPIRY", amount: -remainder, note, createdAt: now },
    });
  }
  balance.planKeys = 0;
  balance.planKeysExpireAt = null;
  await tx.keyBalance.update({
    where: { memberId },
    data: { planKeys: 0, planKeysExpireAt: null },
  });
  return remainder;
}

async function saveBalance(tx: Prisma.TransactionClient, memberId: string, balance: LockedBalance): Promise<void> {
  await tx.keyBalance.update({
    where: { memberId },
    data: {
      planKeys: balance.planKeys,
      purchasedKeys: balance.purchasedKeys,
      planKeysExpireAt: balance.planKeysExpireAt,
    },
  });
}

/** Returns an existing row for (type, reference) so grants are idempotent. */
async function findByReference(db: Db, type: KeyTransactionType, reference: string | undefined) {
  if (!reference) return null;
  return db.keyTransaction.findUnique({ where: { type_reference: { type, reference } } });
}

export interface LedgerOptions {
  db?: Db;
  now?: Date;
}

/**
 * Grant plan keys for a billing period. The pool's expiry becomes `expiresAt`
 * (a new period's grant always comes with a later date; an earlier remainder
 * that already lapsed is expired first by the lazy rule).
 */
export async function grantPlanKeys(
  memberId: string,
  amount: number,
  expiresAt: Date,
  ref: GrantRef = {},
  opts: LedgerOptions = {},
) {
  assertPositiveInt(amount, "amount");
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  if (expiresAt <= now) throw new KeysError("expiresAt must be in the future");
  const existing = await findByReference(db, "PLAN_GRANT", ref.reference);
  if (existing) return existing;

  return inTx(db, async (tx) => {
    const balance = await lockBalance(tx, memberId, now);
    const row = await tx.keyTransaction.create({
      data: {
        memberId,
        pool: "PLAN",
        type: "PLAN_GRANT",
        amount,
        expiresAt,
        reference: ref.reference ?? null,
        note: ref.note ?? null,
        createdAt: now,
      },
    });
    balance.planKeys += amount;
    balance.planKeysExpireAt =
      balance.planKeysExpireAt && balance.planKeysExpireAt > expiresAt ? balance.planKeysExpireAt : expiresAt;
    await saveBalance(tx, memberId, balance);
    return row;
  });
}

/** Grant never-expiring keys: pack purchase, referral bonus, promo. */
export async function grantPurchasedKeys(
  memberId: string,
  amount: number,
  type: PurchasedGrantType,
  ref: GrantRef = {},
  opts: LedgerOptions = {},
) {
  assertPositiveInt(amount, "amount");
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const existing = await findByReference(db, type, ref.reference);
  if (existing) return existing;

  return inTx(db, async (tx) => {
    const balance = await lockBalance(tx, memberId, now);
    const row = await tx.keyTransaction.create({
      data: {
        memberId,
        pool: "PURCHASED",
        type,
        amount,
        reference: ref.reference ?? null,
        note: ref.note ?? null,
        createdAt: now,
      },
    });
    balance.purchasedKeys += amount;
    await saveBalance(tx, memberId, balance);
    return row;
  });
}

/**
 * Debit `amount` keys for a redemption: PLAN first, then PURCHASED. Throws
 * InsufficientKeysError (nothing written) when the member can't cover it.
 * One ledger row per pool touched, both linked to the redemption.
 */
export async function spendKeys(
  memberId: string,
  amount: number,
  redemptionId: string,
  opts: LedgerOptions = {},
): Promise<SpendBreakdown> {
  assertPositiveInt(amount, "amount");
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  return inTx(db, async (tx) => {
    const balance = await lockBalance(tx, memberId, now);
    const available = balance.planKeys + balance.purchasedKeys;
    if (available < amount) throw new InsufficientKeysError(amount, available);

    const fromPlan = Math.min(balance.planKeys, amount);
    const fromPurchased = amount - fromPlan;
    const rows: Prisma.KeyTransactionCreateManyInput[] = [];
    if (fromPlan > 0) {
      rows.push({ memberId, pool: "PLAN", type: "REDEMPTION", amount: -fromPlan, redemptionId, createdAt: now });
    }
    if (fromPurchased > 0) {
      rows.push({ memberId, pool: "PURCHASED", type: "REDEMPTION", amount: -fromPurchased, redemptionId, createdAt: now });
    }
    await tx.keyTransaction.createMany({ data: rows });
    balance.planKeys -= fromPlan;
    balance.purchasedKeys -= fromPurchased;
    await saveBalance(tx, memberId, balance);
    return { fromPlan, fromPurchased };
  });
}

/**
 * Refund a redemption's keys to the pools they came from by mirroring its
 * REDEMPTION rows. Idempotent: a second call returns the existing refund.
 * Plan keys refunded after their period ended are expired in the same
 * transaction (explicit EXPIRY row), never resurrected.
 *
 * A future partial refund is a smaller mirror of the same rows — the shape
 * is kept so cancellation is never a boolean (CLAUDE.md rule 4).
 */
export async function refundKeys(
  redemptionId: string,
  ref: { note?: string } = {},
  opts: LedgerOptions = {},
): Promise<SpendBreakdown> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  return inTx(db, async (tx) => {
    const debits = await tx.keyTransaction.findMany({ where: { redemptionId, type: "REDEMPTION" } });
    if (debits.length === 0) throw new KeysError(`Redemption ${redemptionId} has no key debits`);
    const memberId = debits[0]!.memberId;
    const balance = await lockBalance(tx, memberId, now);

    const existing = await tx.keyTransaction.findMany({ where: { redemptionId, type: "CANCELLATION_REFUND" } });
    if (existing.length > 0) {
      return {
        fromPlan: existing.filter((r) => r.pool === "PLAN").reduce((s, r) => s + r.amount, 0),
        fromPurchased: existing.filter((r) => r.pool === "PURCHASED").reduce((s, r) => s + r.amount, 0),
      };
    }

    let fromPlan = 0;
    let fromPurchased = 0;
    for (const debit of debits) {
      const amount = -debit.amount;
      await tx.keyTransaction.create({
        data: {
          memberId,
          pool: debit.pool,
          type: "CANCELLATION_REFUND",
          amount,
          redemptionId,
          note: ref.note ?? null,
          createdAt: now,
        },
      });
      if (debit.pool === "PLAN") {
        fromPlan += amount;
        balance.planKeys += amount;
      } else {
        fromPurchased += amount;
        balance.purchasedKeys += amount;
      }
    }
    // Plan keys returned to a pool whose period already ended expire at once.
    if (fromPlan > 0 && (!balance.planKeysExpireAt || balance.planKeysExpireAt <= now)) {
      await writeExpiry(tx, memberId, balance, now, "refund into an ended period");
    }
    await saveBalance(tx, memberId, balance);
    return { fromPlan, fromPurchased };
  });
}

/**
 * Period-end job entry point: write the EXPIRY row for the unused plan
 * remainder. No-op when the pool's expiry is later than `periodEnd` (a newer
 * period's grant is already in place) or when there is nothing to expire.
 * Never touches the PURCHASED pool.
 */
export async function expirePlanKeys(
  memberId: string,
  periodEnd: Date,
  opts: LedgerOptions = {},
): Promise<{ expired: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  return inTx(db, async (tx) => {
    // The lazy rule in lockBalance already expires a pool whose date passed;
    // report that as this call's work.
    const balance = await lockBalance(tx, memberId, now);
    if (balance.lazilyExpired > 0) return { expired: balance.lazilyExpired };
    if (!balance.planKeysExpireAt || balance.planKeysExpireAt > periodEnd) return { expired: 0 };
    const expired = await writeExpiry(tx, memberId, balance, now, `period ended ${periodEnd.toISOString()}`);
    return { expired };
  });
}

/**
 * Staff adjustment (ADMIN only — enforced by the caller). Signed amount on
 * either pool; a negative adjustment may not take the pool below zero.
 * Plan-pool credits require an existing, unexpired plan period to land in.
 */
export async function adjustKeys(
  memberId: string,
  pool: KeyPool,
  amount: number,
  input: { reason: string; staffId: string },
  opts: LedgerOptions = {},
) {
  if (!Number.isInteger(amount) || amount === 0) throw new KeysError("amount must be a non-zero integer");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new KeysError("A reason is required");
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  return inTx(db, async (tx) => {
    const balance = await lockBalance(tx, memberId, now);
    const current = pool === "PLAN" ? balance.planKeys : balance.purchasedKeys;
    if (current + amount < 0) throw new InsufficientKeysError(-amount, current);
    if (pool === "PLAN" && amount > 0 && !balance.planKeysExpireAt) {
      throw new KeysError("No active plan period to credit plan keys into — grant purchased keys instead");
    }
    const row = await tx.keyTransaction.create({
      data: {
        memberId,
        pool,
        type: "ADMIN_ADJUSTMENT",
        amount,
        expiresAt: pool === "PLAN" && amount > 0 ? balance.planKeysExpireAt : null,
        note: reason,
        createdById: input.staffId,
        createdAt: now,
      },
    });
    if (pool === "PLAN") balance.planKeys += amount;
    else balance.purchasedKeys += amount;
    await saveBalance(tx, memberId, balance);
    return row;
  });
}

/**
 * Effective balance from the cache (no writes): plan keys whose period has
 * ended count as 0 even before the EXPIRY row is written.
 */
export async function getBalance(memberId: string, opts: LedgerOptions = {}): Promise<Balance> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const row = await db.keyBalance.findUnique({ where: { memberId } });
  if (!row) return { planKeys: 0, purchasedKeys: 0, total: 0, planKeysExpireAt: null };
  const expired = !row.planKeysExpireAt || row.planKeysExpireAt <= now;
  const planKeys = expired ? 0 : row.planKeys;
  return {
    planKeys,
    purchasedKeys: row.purchasedKeys,
    total: planKeys + row.purchasedKeys,
    planKeysExpireAt: expired ? null : row.planKeysExpireAt,
  };
}

export interface LedgerFilter {
  pool?: KeyPool;
  type?: KeyTransactionType;
  from?: Date;
  to?: Date;
  take?: number;
  skip?: number;
}

/** Ledger rows for a member, newest first, with optional filters (backoffice). */
export async function getLedger(memberId: string, filter: LedgerFilter = {}, opts: LedgerOptions = {}) {
  const db = opts.db ?? defaultPrisma;
  const where: Prisma.KeyTransactionWhereInput = {
    memberId,
    ...(filter.pool ? { pool: filter.pool } : {}),
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.keyTransaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(filter.take ?? 100, 500),
      skip: filter.skip ?? 0,
      include: { createdBy: { select: { email: true, name: true } } },
    }),
    db.keyTransaction.count({ where }),
  ]);
  return { rows, total };
}
