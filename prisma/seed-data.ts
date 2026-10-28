/**
 * Seed data (docs/PRODUCT_SPEC.md §3 placeholders + docs/DATA_MODEL.md settings).
 * Everything here is a PLACEHOLDER to be tuned in the backoffice before launch —
 * the seed never overwrites a value that already exists, so edits survive re-runs.
 *
 * Exported as a function so the Vitest smoke test can run it against the test DB;
 * prisma/seed.ts is the CLI entry (`pnpm db:seed`).
 */
import type { BillingPeriod, PrismaClient, TierCode } from "@prisma/client";
import { SETTING_DEFAULTS } from "../src/lib/settings";
import { generateReferralCode } from "../src/lib/referral-code";

export interface SeedOptions {
  /** The one ADMIN staff user. Also gets a Member row so the magic link signs them in. */
  adminEmail: string;
  adminName?: string;
  /** Optional plain member for testing the member sign-in. */
  memberEmail?: string;
  log?: (msg: string) => void;
}

export interface SeedSummary {
  cityId: string;
  tiers: number;
  plans: number;
  planPrices: number;
  keyPacks: number;
  settings: number;
  staffId: string;
  adminMemberId: string;
}

const TIERS: Array<{
  code: TierCode;
  name: string;
  keysPerMonth: number;
  monthlyCents: number;
  privateSaleByDefault: boolean;
  plusOneByDefault: boolean;
}> = [
  // FREE: spec says 0–2 keys/month (open item §17). 2 lets free members try the mechanic once.
  { code: "FREE", name: "Free", keysPerMonth: 2, monthlyCents: 0, privateSaleByDefault: false, plusOneByDefault: false },
  { code: "SOCIAL", name: "Social", keysPerMonth: 30, monthlyCents: 1500, privateSaleByDefault: false, plusOneByDefault: false },
  { code: "REGULAR", name: "Regular", keysPerMonth: 80, monthlyCents: 3000, privateSaleByDefault: false, plusOneByDefault: false },
  { code: "PLUS", name: "Plus", keysPerMonth: 150, monthlyCents: 5000, privateSaleByDefault: true, plusOneByDefault: true },
];

/** Quarterly ≈ 10% off, yearly ≈ 2 months free (spec §3). */
export function periodPriceCents(monthlyCents: number, period: BillingPeriod): number {
  switch (period) {
    case "MONTHLY":
      return monthlyCents;
    case "QUARTERLY":
      return Math.round(monthlyCents * 3 * 0.9);
    case "YEARLY":
      return monthlyCents * 10;
    case "TOURIST_WEEK":
      throw new Error("TOURIST_WEEK has its own price");
  }
}

const PAID_PERIODS: BillingPeriod[] = ["MONTHLY", "QUARTERLY", "YEARLY"];

/** Tourist weekly pass: ~€25, ~50 keys, 7 days, no renewal (spec §3). Hangs off REGULAR for tier rules. */
const TOURIST = { tier: "REGULAR" as TierCode, name: "Tourist week", amountCents: 2500, keys: 50 };

/**
 * Per-key price must stay above REGULAR's (€30 / 80 keys = €0.375) so topping up never beats
 * upgrading (spec §3). The spec's "50 keys / €18" placeholder (€0.36/key) breaks its own rule,
 * so the big pack is seeded at €20 (€0.40/key); the small pack stays at €8 (€0.40/key).
 */
const KEY_PACKS = [
  { code: "PACK_20", name: "20 keys", keys: 20, amountCents: 800, sortOrder: 1 },
  { code: "PACK_50", name: "50 keys", keys: 50, amountCents: 2000, sortOrder: 2 },
];

export async function runSeed(prisma: PrismaClient, opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? (() => undefined);

  // --- City: Lisbon is the only seeded city. No Lisbon-specific logic anywhere else. ---
  const lisbon = await prisma.city.upsert({
    where: { country_name: { country: "PT", name: "Lisbon" } },
    update: {},
    create: { name: "Lisbon", country: "PT", timezone: "Europe/Lisbon", currency: "EUR" },
  });
  log(`city ${lisbon.name} (${lisbon.timezone}, ${lisbon.currency})`);

  // --- Tiers -------------------------------------------------------------------
  const tierIds: Record<TierCode, string> = {} as Record<TierCode, string>;
  for (const [i, t] of TIERS.entries()) {
    const tier = await prisma.tier.upsert({
      where: { code: t.code },
      update: {},
      create: {
        code: t.code,
        name: t.name,
        keysPerMonth: t.keysPerMonth,
        privateSaleByDefault: t.privateSaleByDefault,
        plusOneByDefault: t.plusOneByDefault,
        sortOrder: i,
      },
    });
    tierIds[t.code] = tier.id;
  }
  log(`${TIERS.length} tiers`);

  // --- Plans × periods + prices (Lisbon, EUR) ------------------------------------
  // FREE is a membership too (CLAUDE.md), but it only makes sense as a €0 monthly plan.
  let plans = 0;
  let planPrices = 0;
  const ensurePlan = async (tierCode: TierCode, period: BillingPeriod, name: string, amountCents: number, keysPerPeriod?: number) => {
    const plan = await prisma.plan.upsert({
      where: { tierId_period: { tierId: tierIds[tierCode], period } },
      update: {},
      create: { tierId: tierIds[tierCode], period, name, keysPerPeriod: keysPerPeriod ?? null },
    });
    plans++;
    await prisma.planPrice.upsert({
      where: { planId_cityId: { planId: plan.id, cityId: lisbon.id } },
      update: {},
      create: { planId: plan.id, cityId: lisbon.id, currency: lisbon.currency, amountCents },
    });
    planPrices++;
  };

  for (const t of TIERS) {
    if (t.monthlyCents === 0) {
      await ensurePlan(t.code, "MONTHLY", `${t.name}`, 0);
      continue;
    }
    for (const period of PAID_PERIODS) {
      const label = period === "MONTHLY" ? "monthly" : period === "QUARTERLY" ? "quarterly" : "yearly";
      await ensurePlan(t.code, period, `${t.name} ${label}`, periodPriceCents(t.monthlyCents, period));
    }
  }
  await ensurePlan(TOURIST.tier, "TOURIST_WEEK", TOURIST.name, TOURIST.amountCents, TOURIST.keys);
  log(`${plans} plans, ${planPrices} prices`);

  // --- Key packs -----------------------------------------------------------------
  for (const k of KEY_PACKS) {
    await prisma.keyPack.upsert({
      where: { code: k.code },
      update: {},
      create: { ...k, currency: lisbon.currency },
    });
  }
  log(`${KEY_PACKS.length} key packs`);

  // --- Global settings (create-only: staff edits win) -------------------------------
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  log(`${Object.keys(SETTING_DEFAULTS).length} settings`);

  // --- ADMIN staff user (+ Member row so magic-link sign-in works) --------------------
  const adminEmail = opts.adminEmail.trim().toLowerCase();
  const staff = await prisma.staffUser.upsert({
    where: { email: adminEmail },
    update: { isActive: true },
    create: { email: adminEmail, name: opts.adminName ?? null, role: "ADMIN" },
  });
  const adminMember = await ensureMember(prisma, adminEmail, opts.adminName ?? null, lisbon.id);
  log(`ADMIN staff ${adminEmail}`);

  if (opts.memberEmail) {
    await ensureMember(prisma, opts.memberEmail.trim().toLowerCase(), null, lisbon.id);
    log(`member ${opts.memberEmail}`);
  }

  return {
    cityId: lisbon.id,
    tiers: TIERS.length,
    plans,
    planPrices,
    keyPacks: KEY_PACKS.length,
    settings: Object.keys(SETTING_DEFAULTS).length,
    staffId: staff.id,
    adminMemberId: adminMember.id,
  };
}

async function ensureMember(prisma: PrismaClient, email: string, name: string | null, cityId: string) {
  const existing = await prisma.member.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.member.create({
    data: { email, name, cityId, referralCode: generateReferralCode() },
  });
}
