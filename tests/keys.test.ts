import { beforeAll, describe, expect, it } from "vitest";
import {
  InsufficientKeysError,
  KeysError,
  adjustKeys,
  expirePlanKeys,
  getBalance,
  getLedger,
  grantPlanKeys,
  grantPurchasedKeys,
  reconcileBalances,
  refundKeys,
  spendKeys,
} from "@/domain/keys";
import { prisma, resetDatabase } from "./db";
import { createMember, createRedemption, createStaff } from "./fixtures";

const DAY = 86_400_000;
const inDays = (d: number, from = new Date()) => new Date(from.getTime() + d * DAY);

async function ledgerSum(memberId: string, pool?: "PLAN" | "PURCHASED") {
  const agg = await prisma.keyTransaction.aggregate({ _sum: { amount: true }, where: { memberId, ...(pool ? { pool } : {}) } });
  return agg._sum.amount ?? 0;
}

async function cache(memberId: string) {
  return prisma.keyBalance.findUniqueOrThrow({ where: { memberId } });
}

describe("keys ledger", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  describe("invariant 1 — balance never negative", () => {
    it("rejects a spend the member cannot cover and writes nothing", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 10, inDays(30));
      const r = await createRedemption(m.id, 25);
      await expect(spendKeys(m.id, 25, r.id)).rejects.toBeInstanceOf(InsufficientKeysError);
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, type: "REDEMPTION" } })).toBe(0);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 10, purchasedKeys: 0, total: 10 });
      await expect(spendKeys(m.id, 0, r.id)).rejects.toBeInstanceOf(KeysError);
    });

    it("serialises concurrent spends: 50 keys, ten spends of 10 → exactly five succeed", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 30, inDays(30));
      await grantPurchasedKeys(m.id, 20, "PACK_PURCHASE");
      const redemptions = await Promise.all(Array.from({ length: 10 }, () => createRedemption(m.id, 10)));
      const results = await Promise.allSettled(redemptions.map((r) => spendKeys(m.id, 10, r.id)));
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(5);
      expect(failed).toHaveLength(5);
      for (const f of failed) expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientKeysError);
      expect(await ledgerSum(m.id)).toBe(0);
      expect(await cache(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 0 });
    });
  });

  describe("invariant 2 — plan pool first, refunds mirror the debit rows", () => {
    it("debits PLAN before PURCHASED and a cross-pool spend writes two rows", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 20, inDays(30));
      await grantPurchasedKeys(m.id, 50, "PACK_PURCHASE");

      const r1 = await createRedemption(m.id, 5);
      expect(await spendKeys(m.id, 5, r1.id)).toEqual({ fromPlan: 5, fromPurchased: 0 });
      expect(await prisma.keyTransaction.count({ where: { redemptionId: r1.id } })).toBe(1);

      const r2 = await createRedemption(m.id, 25);
      expect(await spendKeys(m.id, 25, r2.id)).toEqual({ fromPlan: 15, fromPurchased: 10 });
      const rows = await prisma.keyTransaction.findMany({ where: { redemptionId: r2.id }, orderBy: { pool: "asc" } });
      expect(rows.map((r) => [r.pool, r.amount, r.type])).toEqual([
        ["PLAN", -15, "REDEMPTION"],
        ["PURCHASED", -10, "REDEMPTION"],
      ]);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 40 });
    });

    it("refund after a cross-pool spend restores both pools exactly, once", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 20, inDays(30));
      await grantPurchasedKeys(m.id, 50, "PACK_PURCHASE");
      const r = await createRedemption(m.id, 30);
      await spendKeys(m.id, 30, r.id);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 40 });

      expect(await refundKeys(r.id, { note: "cancelled" })).toEqual({ fromPlan: 20, fromPurchased: 10 });
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 20, purchasedKeys: 50, total: 70 });
      const refunds = await prisma.keyTransaction.findMany({ where: { redemptionId: r.id, type: "CANCELLATION_REFUND" } });
      expect(refunds.map((x) => [x.pool, x.amount]).sort()).toEqual([
        ["PLAN", 20],
        ["PURCHASED", 10],
      ]);

      // Second refund is a no-op mirror of the first.
      expect(await refundKeys(r.id)).toEqual({ fromPlan: 20, fromPurchased: 10 });
      expect(await prisma.keyTransaction.count({ where: { redemptionId: r.id } })).toBe(4);
      expect(await getBalance(m.id)).toMatchObject({ total: 70 });
      expect(await ledgerSum(m.id)).toBe(70);
    });

    it("refunding plan keys into an ended period expires them immediately", async () => {
      const m = await createMember();
      const periodEnd = inDays(1);
      await grantPlanKeys(m.id, 20, periodEnd);
      const r = await createRedemption(m.id, 20);
      await spendKeys(m.id, 20, r.id);
      const later = inDays(2);
      expect(await refundKeys(r.id, {}, { now: later })).toEqual({ fromPlan: 20, fromPurchased: 0 });
      expect(await getBalance(m.id, { now: later })).toMatchObject({ planKeys: 0, purchasedKeys: 0 });
      const expiry = await prisma.keyTransaction.findMany({ where: { memberId: m.id, type: "EXPIRY" } });
      expect(expiry.map((x) => x.amount)).toEqual([-20]);
      expect(await ledgerSum(m.id)).toBe(0);
    });
  });

  describe("invariant 4 — expiry zeroes the plan pool and never touches PURCHASED", () => {
    it("writes an EXPIRY row for the remainder at period end", async () => {
      const m = await createMember();
      const periodEnd = inDays(30);
      await grantPlanKeys(m.id, 30, periodEnd);
      await grantPurchasedKeys(m.id, 15, "REFERRAL_BONUS");
      const r = await createRedemption(m.id, 12);
      await spendKeys(m.id, 12, r.id);

      expect(await expirePlanKeys(m.id, periodEnd, { now: inDays(30, periodEnd) })).toEqual({ expired: 18 });
      const expiry = await prisma.keyTransaction.findFirstOrThrow({ where: { memberId: m.id, type: "EXPIRY" } });
      expect(expiry).toMatchObject({ pool: "PLAN", amount: -18 });
      expect(await ledgerSum(m.id, "PLAN")).toBe(0);
      expect(await ledgerSum(m.id, "PURCHASED")).toBe(15);
      expect(await cache(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 15, planKeysExpireAt: null });
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id, pool: "PURCHASED", type: "EXPIRY" } })).toBe(0);

      // Running the job again finds nothing to expire.
      expect(await expirePlanKeys(m.id, periodEnd, { now: inDays(31, periodEnd) })).toEqual({ expired: 0 });
    });

    it("does not expire a pool whose period ends after the given periodEnd", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 30, inDays(60));
      expect(await expirePlanKeys(m.id, inDays(30))).toEqual({ expired: 0 });
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30 });
    });

    it("expiry is lazy: a spend after the period ended uses purchased keys only", async () => {
      const m = await createMember();
      const periodEnd = inDays(1);
      await grantPlanKeys(m.id, 30, periodEnd);
      await grantPurchasedKeys(m.id, 10, "PACK_PURCHASE");
      const later = inDays(2);
      expect(await getBalance(m.id, { now: later })).toMatchObject({ planKeys: 0, purchasedKeys: 10, total: 10, planKeysExpireAt: null });

      const r = await createRedemption(m.id, 8);
      expect(await spendKeys(m.id, 8, r.id, { now: later })).toEqual({ fromPlan: 0, fromPurchased: 8 });
      const expiry = await prisma.keyTransaction.findFirstOrThrow({ where: { memberId: m.id, type: "EXPIRY" } });
      expect(expiry.amount).toBe(-30);
      expect(await ledgerSum(m.id)).toBe(2);
      expect(await cache(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 2 });
    });

    it("a new period's grant after an unexpired remainder extends the pool to the new date", async () => {
      const m = await createMember();
      const first = inDays(10);
      const second = inDays(40);
      await grantPlanKeys(m.id, 5, first);
      await grantPlanKeys(m.id, 30, second);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 35, planKeysExpireAt: second });
    });
  });

  describe("grants", () => {
    it("are idempotent by reference", async () => {
      const m = await createMember();
      const a = await grantPurchasedKeys(m.id, 20, "PACK_PURCHASE", { reference: "pack:cs_1" });
      const b = await grantPurchasedKeys(m.id, 20, "PACK_PURCHASE", { reference: "pack:cs_1" });
      expect(b.id).toBe(a.id);
      expect(await getBalance(m.id)).toMatchObject({ purchasedKeys: 20 });

      const p1 = await grantPlanKeys(m.id, 30, inDays(30), { reference: "sub:sub_1:2026-11" });
      const p2 = await grantPlanKeys(m.id, 30, inDays(30), { reference: "sub:sub_1:2026-11" });
      expect(p2.id).toBe(p1.id);
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 30, purchasedKeys: 20, total: 50 });
    });

    it("reject non-positive amounts and past expiry dates", async () => {
      const m = await createMember();
      await expect(grantPlanKeys(m.id, -5, inDays(30))).rejects.toBeInstanceOf(KeysError);
      await expect(grantPlanKeys(m.id, 5, inDays(-1))).rejects.toBeInstanceOf(KeysError);
      await expect(grantPurchasedKeys(m.id, 1.5, "PACK_PURCHASE")).rejects.toBeInstanceOf(KeysError);
      expect(await prisma.keyTransaction.count({ where: { memberId: m.id } })).toBe(0);
    });
  });

  describe("admin adjustments", () => {
    it("require a reason, record the staff user, and never take a pool negative", async () => {
      const m = await createMember();
      const staff = await createStaff("ADMIN");
      await expect(adjustKeys(m.id, "PURCHASED", 10, { reason: "", staffId: staff.id })).rejects.toThrow(/reason/);
      await expect(adjustKeys(m.id, "PURCHASED", 0, { reason: "goodwill", staffId: staff.id })).rejects.toBeInstanceOf(KeysError);

      const row = await adjustKeys(m.id, "PURCHASED", 10, { reason: "goodwill after door issue", staffId: staff.id });
      expect(row).toMatchObject({ type: "ADMIN_ADJUSTMENT", pool: "PURCHASED", amount: 10, createdById: staff.id, note: "goodwill after door issue" });
      await expect(adjustKeys(m.id, "PURCHASED", -11, { reason: "clawback", staffId: staff.id })).rejects.toBeInstanceOf(InsufficientKeysError);
      await adjustKeys(m.id, "PURCHASED", -4, { reason: "clawback", staffId: staff.id });
      expect(await getBalance(m.id)).toMatchObject({ purchasedKeys: 6 });

      // Plan credits need a live period to expire with.
      await expect(adjustKeys(m.id, "PLAN", 5, { reason: "comp", staffId: staff.id })).rejects.toThrow(/plan period/);
      const periodEnd = inDays(30);
      await grantPlanKeys(m.id, 10, periodEnd);
      const planRow = await adjustKeys(m.id, "PLAN", 5, { reason: "comp", staffId: staff.id });
      expect(planRow.expiresAt?.getTime()).toBe(periodEnd.getTime());
      expect(await getBalance(m.id)).toMatchObject({ planKeys: 15, purchasedKeys: 6 });
      expect(await ledgerSum(m.id)).toBe(21);
    });
  });

  describe("reads", () => {
    it("getLedger filters by pool and type, newest first", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 30, inDays(30));
      await grantPurchasedKeys(m.id, 20, "PACK_PURCHASE");
      const r = await createRedemption(m.id, 35);
      await spendKeys(m.id, 35, r.id);

      const all = await getLedger(m.id);
      expect(all.total).toBe(4);
      expect(all.rows[0]!.type).toBe("REDEMPTION");
      expect((await getLedger(m.id, { pool: "PURCHASED" })).rows.map((x) => x.amount).sort()).toEqual([-5, 20]);
      expect((await getLedger(m.id, { type: "PLAN_GRANT" })).total).toBe(1);
      expect((await getLedger(m.id, { take: 2 })).rows).toHaveLength(2);
    });
  });

  describe("reconciliation", () => {
    it("reports cache drift and fixes it from the ledger", async () => {
      const m = await createMember();
      await grantPlanKeys(m.id, 30, inDays(30));
      await grantPurchasedKeys(m.id, 20, "PACK_PURCHASE");
      expect((await reconcileBalances()).mismatches).toEqual([]);

      // Simulate the forbidden `UPDATE balance = …` (CLAUDE.md rule 1).
      await prisma.keyBalance.update({ where: { memberId: m.id }, data: { purchasedKeys: 99 } });
      const report = await reconcileBalances();
      expect(report.mismatches).toEqual([{ memberId: m.id, pool: "PURCHASED", ledger: 20, cache: 99 }]);

      const fixed = await reconcileBalances({ fix: true });
      expect(fixed.fixed).toBe(1);
      expect(await cache(m.id)).toMatchObject({ planKeys: 30, purchasedKeys: 20 });
      expect((await reconcileBalances()).mismatches).toEqual([]);
    });
  });
});
