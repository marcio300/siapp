import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, periodPriceCents } from "../prisma/seed-data";
import { SETTING_DEFAULTS } from "@/lib/settings";
import { prisma, resetDatabase } from "./db";

const ADMIN = "admin@test.siapp";

describe("seed", () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it("runs on an empty database", async () => {
    const summary = await runSeed(prisma, { adminEmail: ADMIN, adminName: "Test Admin", memberEmail: "member@test.siapp" });

    const lisbon = await prisma.city.findUniqueOrThrow({ where: { id: summary.cityId } });
    expect(lisbon).toMatchObject({ name: "Lisbon", country: "PT", timezone: "Europe/Lisbon", currency: "EUR", isActive: true });
    expect(await prisma.city.count()).toBe(1);

    const tiers = await prisma.tier.findMany({ orderBy: { sortOrder: "asc" } });
    expect(tiers.map((t) => t.code)).toEqual(["FREE", "SOCIAL", "REGULAR", "PLUS"]);
    expect(tiers.map((t) => t.keysPerMonth)).toEqual([2, 30, 80, 150]);
    expect(tiers.find((t) => t.code === "PLUS")).toMatchObject({ privateSaleByDefault: true, plusOneByDefault: true });

    // FREE monthly + 3 paid tiers × 3 periods + tourist week
    const plans = await prisma.plan.findMany({ include: { tier: true, prices: true } });
    expect(plans).toHaveLength(1 + 3 * 3 + 1);
    expect(summary.plans).toBe(plans.length);
    for (const p of plans) expect(p.prices).toHaveLength(1);

    const tourist = plans.find((p) => p.period === "TOURIST_WEEK")!;
    expect(tourist.keysPerPeriod).toBe(50);
    expect(tourist.prices[0]!.amountCents).toBe(2500);

    const free = plans.find((p) => p.tier.code === "FREE")!;
    expect(free.period).toBe("MONTHLY");
    expect(free.prices[0]!.amountCents).toBe(0);

    const regularYearly = plans.find((p) => p.tier.code === "REGULAR" && p.period === "YEARLY")!;
    expect(regularYearly.prices[0]!.amountCents).toBe(30000); // 2 months free
    const socialQuarterly = plans.find((p) => p.tier.code === "SOCIAL" && p.period === "QUARTERLY")!;
    expect(socialQuarterly.prices[0]!.amountCents).toBe(4050); // 10% off 3 × €15

    const packs = await prisma.keyPack.findMany({ orderBy: { sortOrder: "asc" } });
    expect(packs.map((k) => [k.keys, k.amountCents])).toEqual([
      [20, 800],
      [50, 2000],
    ]);
    // Topping up must never be cheaper per key than REGULAR (€30 / 80 keys).
    const regularPerKey = 3000 / 80;
    for (const k of packs) expect(k.amountCents / k.keys).toBeGreaterThan(regularPerKey);

    const settings = await prisma.setting.findMany();
    expect(settings).toHaveLength(Object.keys(SETTING_DEFAULTS).length);
    expect(settings.find((s) => s.key === "cancellation_window_hours")?.value).toBe(24);

    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { email: ADMIN } });
    expect(staff).toMatchObject({ role: "ADMIN", isActive: true, name: "Test Admin" });
    const adminMember = await prisma.member.findUniqueOrThrow({ where: { email: ADMIN } });
    expect(adminMember.cityId).toBe(lisbon.id);
    expect(adminMember.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(await prisma.member.count()).toBe(2);
  });

  it("is idempotent and never overwrites edited values", async () => {
    await prisma.setting.update({ where: { key: "cancellation_window_hours" }, data: { value: 48 } });
    await prisma.planPrice.updateMany({ where: { amountCents: 1500 }, data: { amountCents: 1700 } });

    const before = {
      plans: await prisma.plan.count(),
      prices: await prisma.planPrice.count(),
      packs: await prisma.keyPack.count(),
      members: await prisma.member.count(),
      staff: await prisma.staffUser.count(),
    };
    await runSeed(prisma, { adminEmail: ADMIN, memberEmail: "member@test.siapp" });
    expect({
      plans: await prisma.plan.count(),
      prices: await prisma.planPrice.count(),
      packs: await prisma.keyPack.count(),
      members: await prisma.member.count(),
      staff: await prisma.staffUser.count(),
    }).toEqual(before);

    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "cancellation_window_hours" } })).value).toBe(48);
    expect(await prisma.planPrice.count({ where: { amountCents: 1700 } })).toBe(1);
  });

  it("period pricing follows the spec discounts", () => {
    expect(periodPriceCents(1500, "MONTHLY")).toBe(1500);
    expect(periodPriceCents(1500, "QUARTERLY")).toBe(4050);
    expect(periodPriceCents(1500, "YEARLY")).toBe(15000);
    expect(() => periodPriceCents(1500, "TOURIST_WEEK")).toThrow();
  });
});
