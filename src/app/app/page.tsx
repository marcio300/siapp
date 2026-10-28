import { requireMemberPage } from "@/lib/authz";
import { signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getBalance } from "@/domain/keys";
import { formatDateOnly } from "@/lib/format";
import { Wordmark } from "@/components/wordmark";
import { KeyIcon } from "@/components/key-icon";

/**
 * Member home — Phase 0 placeholder. Proves the member session works and
 * shows the wallet shape (both pools) with the ledger-derived balance of 0.
 * Balance comes from the keys ledger (Phase 1); Phase 5 adds discovery.
 */
export default async function MemberHome() {
  const user = await requireMemberPage();
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: user.id },
    include: { city: true },
  });
  const balance = await getBalance(member.id);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }


  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-8">
      <header className="flex items-center justify-between">
        <Wordmark />
        <form action={doSignOut}>
          <button className="text-sm text-ink-muted hover:text-ink">Sign out</button>
        </form>
      </header>

      <section className="night-card mt-10 p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Wallet</p>
        <p className="mt-2 flex items-baseline gap-2 font-display text-5xl">
          <KeyIcon className="h-8 w-8 text-red" />
          {balance.total}
        </p>
        <p className="mt-2 font-serif text-base italic text-ink-muted">
          {balance.planKeys} plan keys
          {balance.planKeysExpireAt ? ` expire ${formatDateOnly(balance.planKeysExpireAt, member.city?.timezone)}` : ""} ·{" "}
          {balance.purchasedKeys} purchased
        </p>
      </section>

      <section className="mt-8">
        <h1 className="font-display text-3xl leading-tight">
          you&apos;re in<span className="text-red">.</span>
        </h1>
        <p className="mt-2 font-serif text-xl italic text-ink-muted">
          sorry, nothing tonight — the calendar opens in a later phase.
        </p>
        <dl className="mt-6 space-y-2 text-sm text-ink-muted">
          <div className="flex justify-between">
            <dt>Signed in as</dt>
            <dd className="text-ink">{member.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Home city</dt>
            <dd className="text-ink">{member.city?.name ?? "not chosen yet"}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Referral code</dt>
            <dd className="font-mono text-ink">{member.referralCode}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

