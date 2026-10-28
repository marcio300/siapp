import type { BillingPeriod } from "@prisma/client";

/**
 * Pure date helpers for billing periods. All times UTC (CLAUDE.md rule 11).
 * `addMonths` clamps day overflow (31 Jan + 1 month = 28/29 Feb) like Stripe.
 */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export const TOURIST_PASS_DAYS = 7;

/** Nominal length of a billing period, used only when Stripe hasn't told us the real dates yet. */
export function nominalPeriodEnd(start: Date, period: BillingPeriod): Date {
  switch (period) {
    case "MONTHLY":
      return addMonths(start, 1);
    case "QUARTERLY":
      return addMonths(start, 3);
    case "YEARLY":
      return addMonths(start, 12);
    case "TOURIST_WEEK":
      return addDays(start, TOURIST_PASS_DAYS);
  }
}

export function isRecurring(period: BillingPeriod): boolean {
  return period === "MONTHLY" || period === "QUARTERLY" || period === "YEARLY";
}

/**
 * Keys are granted MONTHLY even on quarterly/yearly plans (spec §2). Given a
 * grant start inside [periodStart, periodEnd), return when that month's keys
 * expire and when the next monthly grant is due (null when the next grant is
 * the renewal itself).
 */
export function monthlyGrantWindow(grantStart: Date, periodEnd: Date): { expiresAt: Date; nextGrantAt: Date | null } {
  const next = addMonths(grantStart, 1);
  if (next >= periodEnd) return { expiresAt: periodEnd, nextGrantAt: null };
  return { expiresAt: next, nextGrantAt: next };
}
