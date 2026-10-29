import Link from "next/link";
import { requireOnboardedMember } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getMembership } from "@/domain/billing";
import { getBalance } from "@/domain/keys";
import { Notice } from "@/components/member-nav";
import { Wordmark } from "@/components/wordmark";
import { deleteAccountAction } from "../actions";

export const metadata = { title: "Delete account" };

export default async function DeleteAccountPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const member = await requireOnboardedMember("/app/profile/delete");
  const { error } = await searchParams;
  const [membership, balance, upcoming] = await Promise.all([
    getMembership(member.id),
    getBalance(member.id),
    prisma.redemption.count({ where: { memberId: member.id, status: { in: ["ACTIVE", "PENDING_PAYMENT", "HELD"] }, event: { startsAt: { gt: new Date() } } } }),
  ]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-8">
      <Wordmark />
      <Link href="/app/profile" className="mt-6 text-sm text-ink-muted hover:text-ink">← back</Link>
      <h1 className="mt-4 font-display text-3xl leading-tight">
        leaving<span className="text-red">?</span>
      </h1>
      <p className="mt-2 font-serif text-lg italic text-ink-muted">this is final. here&apos;s what goes with you.</p>
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}
      <ul className="night-card mt-6 list-disc space-y-2 p-5 pl-9 text-sm text-ink-muted">
        <li>
          <strong className="text-ink">{balance.total} keys</strong> ({balance.planKeys} plan, {balance.purchasedKeys} purchased) are forfeited. Keys have no cash value.
        </li>
        <li>
          {membership.isRecurring ? (
            <>Your <strong className="text-ink">{membership.subscription?.plan.name}</strong> is cancelled now — no further charge, no refund for the current period.</>
          ) : (
            <>Your membership ends now.</>
          )}
        </li>
        <li>
          {upcoming > 0 ? (
            <><strong className="text-ink">{upcoming} upcoming {upcoming === 1 ? "ticket" : "tickets"}</strong> are cancelled where the cutoff still allows it; tickets inside the 24 h window are forfeited.</>
          ) : (
            <>No upcoming tickets.</>
          )}
        </li>
        <li>Your email, name, date of birth, selfie, ID photo and devices are deleted. Financial records we must keep by law stay, anonymised.</li>
        <li>You can sign up again later with the same email — as a new member, from zero.</li>
      </ul>
      <form action={deleteAccountAction} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Type DELETE to confirm</span>
          <input name="confirm" required autoComplete="off" className="input-dark font-mono uppercase" placeholder="DELETE" />
        </label>
        <button className="btn w-full border border-red bg-transparent !py-3 text-red hover:bg-red hover:text-white">Delete my account</button>
      </form>
    </main>
  );
}
