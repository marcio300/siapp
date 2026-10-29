import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { makeMemoryStorage, setMediaStorageForTests } from "@/lib/media/storage";
import { setBillingStripeForTests, type BillingStripe } from "@/domain/billing";
import { DeletionError, deleteAccount, storeSelfie } from "@/domain/identity";
import { getBalance, grantPlanKeys, grantPurchasedKeys, spendKeys } from "@/domain/keys";
import { prisma, resetDatabase } from "./db";
import { createMember, createRedemption } from "./fixtures";

const DAY = 86_400_000;

describe("account deletion", () => {
  const cancelled: string[] = [];
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    setMediaStorageForTests(makeMemoryStorage());
    const stripe: BillingStripe = {
      customers: { async create() { return { id: "cus" }; } },
      checkout: { sessions: { async create() { return { id: "cs", url: "" }; } } },
      subscriptions: { async retrieve(id) { return { id, items: { data: [] } }; }, async update() { return {}; }, async cancel(id) { cancelled.push(id); return {}; } },
      billingPortal: { sessions: { async create() { return { url: "" }; } } },
      refunds: { async create() { return { id: "re" }; } },
    };
    setBillingStripeForTests(stripe);
  });

  it("scrubs personal data, cancels Stripe and cancellable tickets, keeps the ledger, frees the email", async () => {
    const m = await createMember();
    const email = m.email;
    await prisma.member.update({ where: { id: m.id }, data: { name: "Ana Silva", dateOfBirth: new Date("1990-01-01"), onboardedAt: new Date(), emailVerified: new Date() } });
    await storeSelfie(m.id, { data: Buffer.from("x".repeat(2000)), contentType: "image/jpeg" });
    await prisma.device.create({ data: { memberId: m.id, fingerprint: "fp-del" } });
    await prisma.session.create({ data: { userId: m.id, sessionToken: `tok-${m.id}`, expires: new Date(Date.now() + DAY) } });
    const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } } });
    await prisma.subscription.create({ data: { memberId: m.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSubscriptionId: "sub_del", firstPaidAt: new Date() } });
    await grantPlanKeys(m.id, 30, new Date(Date.now() + 20 * DAY), { reference: `del:${m.id}` });
    await grantPurchasedKeys(m.id, 5, "PACK_PURCHASE", { reference: `delpack:${m.id}` });
    const soon = await createRedemption(m.id, 10); // event in 3 days → cancellable
    await spendKeys(m.id, 10, soon.id);
    const late = await createRedemption(m.id, 10);
    await spendKeys(m.id, 10, late.id);
    await prisma.redemption.update({ where: { id: late.id }, data: { cancelDeadlineAt: new Date(Date.now() - DAY) } }); // inside the window → forfeited
    const ledgerBefore = await prisma.keyTransaction.count({ where: { memberId: m.id } });

    const res = await deleteAccount(m.id);
    expect(res).toEqual({ cancelledRedemptions: 1, forfeitedTickets: 1 });
    const row = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ email: `deleted+${m.id}@deleted.siapp.invalid`, name: null, dateOfBirth: null, selfieUrl: null, emailVerified: null });
    expect(row.deletedAt).not.toBeNull();
    expect(cancelled).toEqual(["sub_del"]);
    expect((await prisma.subscription.findFirstOrThrow({ where: { stripeSubscriptionId: "sub_del" } })).status).toBe("CANCELLED");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: soon.id } })).status).toBe("CANCELLED");
    expect((await prisma.redemption.findUniqueOrThrow({ where: { id: late.id } })).status).toBe("ACTIVE"); // becomes a no-show when the event ends
    expect(await prisma.device.count({ where: { memberId: m.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: m.id } })).toBe(0);
    // ledger kept (plus the refund + expiry rows the deletion itself wrote), plan keys expired
    expect(await prisma.keyTransaction.count({ where: { memberId: m.id } })).toBeGreaterThan(ledgerBefore);
    expect(await getBalance(m.id)).toMatchObject({ planKeys: 0, purchasedKeys: 5 }); // 10 refunded into the plan pool then expired; purchased pool dies with the row
    // the email is free again → a brand-new member
    const again = await prisma.member.create({ data: { email, referralCode: `R${m.id.slice(-6).toUpperCase()}` } });
    expect(again.id).not.toBe(m.id);
    await expect(deleteAccount(m.id)).rejects.toThrow(DeletionError);
  });
});
