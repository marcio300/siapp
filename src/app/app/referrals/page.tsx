import { signOut } from "@/lib/auth";
import { requireOnboardedMember } from "@/lib/authz";
import { referralOverview } from "@/domain/referrals";
import { getSetting } from "@/lib/settings";
import { formatDateOnly } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";
import { MemberHeader } from "@/components/member-nav";
import { ShareButton } from "./share-button";

const REASON: Record<string, string> = {
  self_referral: "same person",
  shared_device: "same phone",
  shared_card: "same card",
};

export default async function ReferralsPage() {
  const member = await requireOnboardedMember("/app/referrals");
  const tz = member.city?.timezone;
  const [o, vestingDays] = await Promise.all([referralOverview(member.id), getSetting("referral_vesting_days")]);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app/referrals" signOut={doSignOut} />

      <section className="night-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Your code</p>
        <h1 className="mt-2 font-display text-4xl leading-tight tracking-wider">{o.code}</h1>
        <p className="mt-2 font-serif text-lg italic text-ink-muted">
          {o.active ? (
            <>
              bring a friend. when they pay and show up, you both get <KeyIcon className="inline h-4 w-4 text-red" /> {o.bonusKeys} — the kind that never expire.
            </>
          ) : (
            "your code wakes up when you're on a paid plan. tourist passes don't count."
          )}
        </p>
        <p className="mt-3 break-all font-mono text-xs text-ink-muted">{o.link}</p>
        <div className="mt-4">{o.active ? <ShareButton link={o.link} text="Sorry, it's a private party. Use my key to get in:" /> : <a href="/app/membership" className="btn btn-primary w-full !py-3 !text-base">Pick a plan</a>}</div>
        <p className="mt-3 text-xs text-ink-muted">
          vests {vestingDays} days after their first payment, once they&apos;ve been scanned in. max {o.monthlyCap} a month ({o.vestedThisMonth} so far this month).
        </p>
      </section>

      <section className="grid grid-cols-3 gap-2 text-center">
        {[
          ["pending", o.counts.pending],
          ["vested", o.counts.vested],
          ["keys earned", o.keysEarned],
        ].map(([label, n]) => (
          <div key={label} className="night-card p-3">
            <p className="font-display text-2xl">{n}</p>
            <p className="text-xs text-ink-muted">{label}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="font-display text-2xl leading-tight">
          your people<span className="text-red">.</span>
        </h2>
        {o.referrals.length === 0 ? (
          <p className="mt-2 font-serif italic text-ink-muted">nobody yet. the list starts when someone signs up with your code.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {o.referrals.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-semibold">{r.inviteeLabel}</p>
                  <p className="text-xs text-ink-muted">joined {formatDateOnly(r.createdAt, tz)}{r.vestedAt ? ` · vested ${formatDateOnly(r.vestedAt, tz)}` : ""}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${r.status === "VESTED" ? "bg-ok/20 text-ok" : r.status === "REJECTED" ? "bg-red/15 text-red-soft" : "bg-warn/20 text-warn"}`}>
                  {r.status === "VESTED" ? `+${o.bonusKeys} keys` : r.status === "REJECTED" ? `not counted · ${REASON[r.rejectedReason ?? ""] ?? "flagged"}` : "pending"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {o.referredBy && (
        <p className="text-xs text-ink-muted">
          you came in with code {o.referredBy.code} · {o.referredBy.status === "VESTED" ? `your ${o.bonusKeys} keys have landed` : o.referredBy.status === "PENDING" ? "your welcome keys land once you've paid and been scanned in" : "that referral didn't count"}.
        </p>
      )}
    </main>
  );
}
