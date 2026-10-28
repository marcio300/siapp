"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireStaff } from "@/lib/authz";
import { getStripe } from "@/lib/stripe";
import { syncStripePrices } from "@/domain/billing";

const Money = z.coerce.number().min(0).max(100000);
const Keys = z.coerce.number().int().min(0).max(100000);

function back(params: Record<string, string>): never {
  redirect(`/admin/plans?${new URLSearchParams(params).toString()}`);
}

/** ADMIN: tier keys per month. */
export async function updateTierAction(formData: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const parsed = z.object({ tierId: z.string().min(1), keysPerMonth: Keys }).safeParse({
    tierId: formData.get("tierId"),
    keysPerMonth: formData.get("keysPerMonth"),
  });
  if (!parsed.success) back({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  await prisma.tier.update({ where: { id: parsed.data.tierId }, data: { keysPerMonth: parsed.data.keysPerMonth } });
  back({ saved: "tier" });
}

/** ADMIN: a plan price in euros (stored in cents) and, for the tourist pass, its key amount. */
export async function updatePlanPriceAction(formData: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const parsed = z
    .object({ planPriceId: z.string().min(1), amountEuros: Money, keysPerPeriod: Keys.optional() })
    .safeParse({
      planPriceId: formData.get("planPriceId"),
      amountEuros: formData.get("amountEuros"),
      keysPerPeriod: formData.get("keysPerPeriod") === null ? undefined : formData.get("keysPerPeriod"),
    });
  if (!parsed.success) back({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const price = await prisma.planPrice.update({
    where: { id: parsed.data.planPriceId },
    data: { amountCents: Math.round(parsed.data.amountEuros * 100) },
  });
  if (parsed.data.keysPerPeriod !== undefined) {
    await prisma.plan.update({ where: { id: price.planId }, data: { keysPerPeriod: parsed.data.keysPerPeriod } });
  }
  back({ saved: "plan" });
}

/** ADMIN: key pack keys + price. */
export async function updateKeyPackAction(formData: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const parsed = z
    .object({ keyPackId: z.string().min(1), keys: Keys.min(1), amountEuros: Money, isActive: z.coerce.boolean() })
    .safeParse({
      keyPackId: formData.get("keyPackId"),
      keys: formData.get("keys"),
      amountEuros: formData.get("amountEuros"),
      isActive: formData.get("isActive") === "on",
    });
  if (!parsed.success) back({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  await prisma.keyPack.update({
    where: { id: parsed.data.keyPackId },
    data: { keys: parsed.data.keys, amountCents: Math.round(parsed.data.amountEuros * 100), isActive: parsed.data.isActive },
  });
  back({ saved: "pack" });
}

/** ADMIN: push plans/packs to Stripe (same core as `pnpm stripe:sync-prices`). */
export async function syncStripePricesAction(): Promise<void> {
  await requireStaff("ADMIN");
  let summary = "";
  try {
    const r = await syncStripePrices(prisma, getStripe());
    summary = `products +${r.productsCreated} ~${r.productsUpdated}, prices +${r.pricesCreated}, archived ${r.pricesArchived}, unchanged ${r.skipped}`;
  } catch (e) {
    back({ error: e instanceof Error ? e.message : "Stripe sync failed" });
  }
  back({ synced: summary });
}
