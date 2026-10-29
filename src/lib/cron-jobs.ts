import { runExpirePeriods, runMonthlyGrants } from "@/domain/billing/subscriptions";
import { purgeIdPhotos } from "@/domain/identity/photos";
import { reconcileBalances } from "@/domain/keys/reconcile";
import { sendEventReminders, sendKeysExpiringNotices, sendTouristExpiringNotices } from "@/domain/notifications/jobs";
import { expirePendingPayments, expireWaitlistClaims, markNoShows } from "@/domain/redemption/lifecycle";
import { vestReferrals } from "@/domain/referrals/vesting";
import { settleEvents } from "@/domain/settlement/settle";

/**
 * Every scheduled job, by the name Vercel Cron calls it with
 * (`/api/cron/<name>`, see vercel.json). The `pnpm jobs:*` scripts run the
 * same functions from a shell. Keep this the single list.
 */
export type CronJobName = keyof typeof CRON_JOBS;

export const CRON_JOBS = {
  /** daily — quarterly/yearly monthly key grants + FREE's rolling month */
  "monthly-grants": () => runMonthlyGrants(),
  /** hourly — ended periods: plan keys expire, tourist/promo passes → FREE */
  "expire-periods": () => runExpirePeriods(),
  /** hourly — ended events: ACTIVE → NO_SHOW (+ notice), event FINISHED */
  "mark-no-shows": () => markNoShows(),
  /** daily — referral vesting */
  "vest-referrals": () => vestReferrals(),
  /** hourly — finished events → settlements + producer statements */
  "settle-events": () => settleEvents(),
  /** daily — ledger sums vs KeyBalance cache (report only; `pnpm jobs:reconcile-balances --fix` rewrites) */
  "reconcile-balances": async () => {
    const r = await reconcileBalances();
    return { checked: r.membersChecked, mismatches: r.mismatches.length, ok: r.mismatches.length === 0 };
  },
  /** daily — tourist ID photos older than 30 days */
  "purge-id-photos": () => purgeIdPhotos(),
  /** every 5 min — notified waitlist spots nobody claimed */
  "expire-waitlist-claims": () => expireWaitlistClaims(),
  /** every 5 min — discounted-ticket holds nobody paid */
  "expire-pending-payments": () => expirePendingPayments(),
  /** hourly — "tomorrow night" reminders 25 h before start */
  "event-reminders": () => sendEventReminders(),
  /** hourly — plan keys expiring within 3 days */
  "keys-expiring": () => sendKeysExpiringNotices(),
  /** hourly — tourist passes ending within 24 h */
  "tourist-expiring": () => sendTouristExpiringNotices(),
} as const satisfies Record<string, () => Promise<unknown>>;

export function isCronJobName(name: string): name is CronJobName {
  return Object.prototype.hasOwnProperty.call(CRON_JOBS, name);
}

/** Bearer-token check shared by the route and tests. Without CRON_SECRET configured, nothing runs. */
export function cronAuthorized(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function runCronJob(name: CronJobName): Promise<{ job: CronJobName; ms: number; result: unknown }> {
  const started = Date.now();
  const result = await CRON_JOBS[name]();
  return { job: name, ms: Date.now() - started, result };
}
