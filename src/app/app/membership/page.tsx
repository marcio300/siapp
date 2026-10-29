import { prisma } from "@/lib/db";
import { signOut } from "@/lib/auth";
import { requireOnboardedMember } from "@/lib/authz";
import { getMembership, isRecurring, keysForPlan } from "@/domain/billing";
import { formatDateOnly, formatMoney } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";
import { MemberHeader, Notice } from "@/components/member-nav";
import { cancelRenewalAction, choosePlanAction, claimPartnerAction, portalAction, resumeRenewalAction, touristPassAction } from "./actions";

const PERIOD_LABEL = { MONTHLY: "month", QUARTERLY: "quarter", YEARLY: "year", TOURIST_WEEK: "week" } as const;

export default async function MembershipPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await requireOnboardedMember("/app/membership");
  const sp = await searchParams;
  const membership = await getMembership(member.id);
  const sub = membership.subscription;
  const tz = member.city?.timezone;

  const prices = await prisma.planPrice.findMany({
    where: {
      amountCents: { gt: 0 },
      stripePriceId: { not: null },
      plan: { isActive: true, period: { in: ["MONTHLY", "QUARTERLY", "YEARLY"] }, tier: { isActive: true } },
      ...(member.cityId ? { cityId: member.cityId } : {}),
    },
    include: { plan: { include: { tier: true } } },
    orderBy: [{ plan: { tier: { sortOrder: "asc" } } }, { plan: { period: "asc" } }],
  });
  const tourist = await prisma.planPrice.findFirst({
    where: { stripePriceId: { not: null }, plan: { isActive: true, period: "TOURIST_WEEK" }, ...(member.cityId ? { cityId: member.cityId } : {}) },
    include: { plan: { include: { tier: true } } },
  });
  const [storedToken, claims] = await Promise.all([
    prisma.member.findUnique({ where: { id: member.id }, select: { partnerClaimToken: true } }),
    prisma.partnerClaim.findMany({ where: { memberId: member.id }, include: { community: { select: { name: true } } }, orderBy: { claimedAt: "desc" } }),
  ]);
  const byTier = new Map<string, typeof prices>();
  for (const p of prices) byTier.set(p.plan.tier.code, [...(byTier.get(p.plan.tier.code) ?? []), p]);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app/membership" signOut={doSignOut} />

      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {sp.changed && <Notice tone="ok">Plan changed. Keys for the new tier arrive with your next period.</Notice>}
      {sp.cancelled && <Notice tone="ok">Renewal cancelled. You keep everything until the period ends.</Notice>}
      {sp.resumed && <Notice tone="ok">Welcome back. Your plan renews as usual.</Notice>}
      {sp.claimed && <Notice tone="ok">Claimed — {sp.claimed}.</Notice>}

      <section className="night-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Your membership</p>
        <h1 className="mt-2 font-display text-3xl leading-tight">
          {sub?.plan.tier.name.toLowerCase() ?? "free"}
          {membership.isTourist && <span className="text-red"> · tourist</span>}
        </h1>
        <p className="mt-2 flex items-center gap-2 font-serif text-lg italic text-ink-muted">
          <KeyIcon /> {membership.keysPerMonth} {membership.isTourist ? "keys for the week" : "keys a month"}
        </p>
        {sub && (
          <dl className="mt-4 space-y-1.5 text-sm text-ink-muted">
            {membership.isRecurring && (
              <div className="flex justify-between">
                <dt>{sub.cancelAtPeriodEnd ? "Ends on" : "Renews on"}</dt>
                <dd className="text-ink">{formatDateOnly(sub.currentPeriodEnd, tz)}</dd>
              </div>
            )}
            {membership.isTourist && (
              <div className="flex justify-between">
                <dt>Pass valid until</dt>
                <dd className="text-ink">{formatDateOnly(sub.currentPeriodEnd, tz)}</dd>
              </div>
            )}
            {sub.status === "PAST_DUE" && (
              <div className="flex justify-between">
                <dt>Payment</dt>
                <dd className="text-warn">failed — update your card</dd>
              </div>
            )}
          </dl>
        )}
        {membership.isRecurring && (
          <div className="mt-5 flex flex-wrap gap-2">
            {sub?.cancelAtPeriodEnd ? (
              <form action={resumeRenewalAction}>
                <button className="btn btn-primary">Keep my membership</button>
              </form>
            ) : (
              <form action={cancelRenewalAction}>
                <button className="btn border border-line text-ink-muted hover:text-ink">Cancel renewal</button>
              </form>
            )}
            <form action={portalAction}>
              <button className="btn border border-line text-ink-muted hover:text-ink">Card &amp; invoices</button>
            </form>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-2xl leading-tight">
          {membership.isRecurring ? "change plan" : "pick a plan"}
          <span className="text-red">.</span>
        </h2>
        <p className="mt-1 font-serif text-base italic text-ink-muted">
          {membership.isRecurring
            ? "upgrades are prorated by Stripe. keys for the new tier land with your next period, not today."
            : "quarterly saves 10%. yearly gets two months free. keys land every month either way."}
        </p>
        <form action={choosePlanAction} className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="mode" value={membership.isRecurring ? "change" : "subscribe"} />
          {[...byTier.entries()].map(([tierCode, tierPrices]) => {
            const tier = tierPrices[0]!.plan.tier;
            return (
              <div key={tierCode} className="night-card p-4">
                <div className="flex items-baseline justify-between">
                  <p className="font-display text-xl">{tier.name.toLowerCase()}</p>
                  <p className="flex items-center gap-1 text-sm text-ink-muted">
                    <KeyIcon /> {tier.keysPerMonth} / month
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {tierPrices.map((p) => {
                    const current = sub?.planId === p.planId && (membership.isRecurring || membership.isPaid);
                    return (
                      <button
                        key={p.id}
                        name="planPriceId"
                        value={p.id}
                        disabled={current}
                        className={`w-full rounded-xl border px-2 py-2 text-center text-sm transition ${
                          current ? "border-red bg-red/10 text-ink" : "border-line hover:border-red-soft"
                        }`}
                      >
                        <span className="block font-semibold">{formatMoney(p.amountCents, p.currency)}</span>
                        <span className="block text-xs text-ink-muted">
                          {current ? "current" : `per ${PERIOD_LABEL[p.plan.period]}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {prices.length === 0 && (
            <Notice tone="error">No plans are on sale yet — prices need a Stripe sync (backoffice → Plans).</Notice>
          )}
          <div className="night-card mt-1 p-4 text-xs text-ink-muted">
            <p className="font-semibold text-ink">Before you subscribe (EU consumer law, in plain words)</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>Your plan <strong className="text-ink">renews automatically</strong> at the end of each period at the price shown, until you cancel. Cancel any time here (Membership → Cancel renewal); you keep the period you paid for.</li>
              <li>Plan keys expire at the end of each period. Purchased keys don&apos;t.</li>
              <li>You can withdraw within 14 days; keys used in that time are deducted. Prices include VAT.</li>
            </ul>
            <label className="mt-3 flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" name="acceptTerms" required className="mt-0.5 h-4 w-4 accent-red" />
              <span>I understand the plan renews automatically and I agree to the <a href="/legal/terms" target="_blank" className="underline">terms</a>.</span>
            </label>
          </div>
        </form>
      </section>

      {tourist && !membership.isPaid && (
        <section className="night-card p-4">
          <div className="flex items-baseline justify-between">
            <p className="font-display text-xl">in town for a week?</p>
            <p className="text-sm text-ink-muted">{formatMoney(tourist.amountCents, tourist.currency)}</p>
          </div>
          <p className="mt-1 font-serif text-base italic text-ink-muted">
            the tourist pass: <KeyIcon className="inline h-3.5 w-3.5 text-red" /> {keysForPlan(tourist.plan)} keys, 7 days from
            purchase, no renewal.
          </p>
          <form action={touristPassAction} className="mt-3">
            <button className="btn btn-primary w-full">Get the weekly pass</button>
          </form>
        </section>
      )}

      {sub && isRecurring(sub.plan.period) && sub.plan.period !== "MONTHLY" && (
        <p className="text-xs text-ink-muted">
          Your {PERIOD_LABEL[sub.plan.period]}ly plan still grants keys monthly — unused keys expire at each month&apos;s end.
        </p>
      )}
      <section className="night-card p-5">
        <h2 className="font-display text-xl leading-tight">
          partner membership<span className="text-red">.</span>
        </h2>
        <p className="mt-1 font-serif italic text-ink-muted">
          {claims.length > 0
            ? `claimed: ${claims.map((c) => `${c.community.name} (${formatDateOnly(c.claimedAt, tz)})`).join(", ")}.`
            : "in erasmus life lisboa or another partner community? paste the token they gave you and we apply the promo."}
        </p>
        {storedToken?.partnerClaimToken && (
          <p className="mt-2 text-xs text-warn">we still have the token you entered at signup — hit claim to try it again.</p>
        )}
        <form action={claimPartnerAction} className="mt-3 flex flex-col gap-2">
          <input name="token" maxLength={4096} className="input-dark font-mono text-xs" placeholder={storedToken?.partnerClaimToken ? "(using the stored token)" : "paste your token"} />
          <button className="btn border border-line text-ink-muted hover:text-ink">Claim</button>
        </form>
      </section>
    </main>
  );
}
