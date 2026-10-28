import { prisma } from "@/lib/db";

/**
 * Global settings (CLAUDE.md "Feature flags via a Setting table"). The
 * defaults below are the ones listed in docs/DATA_MODEL.md; the seed writes
 * them once and never overwrites a value staff changed in the backoffice.
 */
export const SETTING_DEFAULTS = {
  cancellation_window_hours: 24,
  waitlist_claim_minutes: 60,
  overlap_tolerance_hours: 3,
  referral_bonus_keys: 10,
  referral_monthly_cap: 20,
  referral_vesting_days: 30,
  velocity_first_hour_max: 3,
  velocity_private_sale_first_day_max: 1,
  device_max_accounts: 3,
  same_card_max_accounts: 1,
  pending_payment_minutes: 10,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  cancellation_window_hours: "Hours before event start until which a member may cancel a redemption",
  waitlist_claim_minutes: "Minutes a notified waitlist member has to claim a freed spot",
  overlap_tolerance_hours: "Active redemptions for events starting within this many hours of each other are refused",
  referral_bonus_keys: "Keys granted to referrer and invitee when a referral vests",
  referral_monthly_cap: "Max vested referrals per referrer per month",
  referral_vesting_days: "Days after the invitee's first payment before a referral can vest",
  velocity_first_hour_max: "Redemptions in a new account's first hour before fraud review",
  velocity_private_sale_first_day_max: "Private-sale redemptions in a new account's first day before fraud review",
  device_max_accounts: "Accounts allowed per device fingerprint before fraud review",
  same_card_max_accounts: "Accounts allowed per Stripe card fingerprint before fraud review",
  pending_payment_minutes: "Minutes a discounted-ticket redemption may stay PENDING_PAYMENT before releasing capacity",
};

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return SETTING_DEFAULTS[key];
  return row.value as (typeof SETTING_DEFAULTS)[K];
}
