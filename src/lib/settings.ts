import type { Prisma, PrismaClient } from "@prisma/client";
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
  // EventOS partner API (docs/EVENTOS_INTEGRATION.md, contract §2.1/§6). €1 per key, owner 2026-11-08.
  key_value_cents: 100,
  min_key_cost: 2,
  guestlist_key_cost: 10,
  key_cost_override_pct: 0,
  min_discount_percent: 10,
  max_discount_percent: 99,
  partner_payment_hold_minutes: 15,
  eventos_noshow_grace_hours: 6,
  partner_photo_ttl_hours: 24,
  partner_max_offers_per_event: 10,
  partner_rate_limit_per_minute: 120,
  // Launch switch: 0 = public sign-in closed (only staff, existing members and INVITED founder leads can
  // sign in; nobody else can create an account); 1 = open to everyone. Flipped in /admin/settings.
  public_signin_open: 0 as 0 | 1,
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
  key_value_cents: "Member value one key represents (the pricing rule for EventOS offers: keys = value ÷ this)",
  min_key_cost: "Floor for any EventOS offer's key cost",
  guestlist_key_cost: "Fixed key cost of an EventOS guest-list offer",
  key_cost_override_pct: "Band (%) a producer may nudge a computed key cost by — 0 = none",
  min_discount_percent: "Minimum discount an EventOS producer can offer SIAPP members",
  max_discount_percent: "Maximum discount (100 % = use a full-redemption offer instead)",
  partner_payment_hold_minutes: "Minutes a producer-collects redemption may stay PENDING_PAYMENT",
  eventos_noshow_grace_hours: "Hours after an EventOS event ends before no-shows are marked (late check-in syncs)",
  partner_photo_ttl_hours: "Hours after an event ends that a signed selfie URL stays valid for the producer's scanner",
  partner_max_offers_per_event: "Maximum SIAPP offers an EventOS producer may configure on one event",
  partner_rate_limit_per_minute: "Partner API requests per minute per key",
  public_signin_open: "1 = anyone can sign in / create an account; 0 = closed until launch (staff, existing members and invited founders only)",
};

/**
 * Pass the transaction client when reading inside a transaction: the global
 * client would need a SECOND pool connection, and under load that deadlocks
 * the pool (every connection held by a transaction waiting for one more).
 */
export async function getSetting<K extends SettingKey>(key: K, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return SETTING_DEFAULTS[key];
  return row.value as (typeof SETTING_DEFAULTS)[K];
}

/** Staff edit (ADMIN): writes the row the backoffice reads. Create-only seeding never overwrites it. */
export async function setSetting<K extends SettingKey>(key: K, value: (typeof SETTING_DEFAULTS)[K], db: PrismaClient = prisma): Promise<void> {
  await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}
