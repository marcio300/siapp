import { prisma } from "@/lib/db";
import { signOut } from "@/lib/auth";
import { requireOnboardedMember } from "@/lib/authz";
import { getMembership } from "@/domain/billing";
import { getBalance, getLedger } from "@/domain/keys";
import { formatDate, formatDateOnly, formatMoney } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";
import { MemberHeader, Notice } from "@/components/member-nav";
import { buyPackAction } from "./actions";

const TYPE_LABEL: Record<string, string> = {
  PLAN_GRANT: "plan keys",
  PACK_PURCHASE: "key pack",
  REDEMPTION: "redeemed",
  CANCELLATION_REFUND: "refund",
  REFERRAL_BONUS: "referral bonus",
  EXPIRY: "expired",
  ADMIN_ADJUSTMENT: "adjustment",
  PROMO_GRANT: "promo",
};

export default async function WalletPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const member = await requireOnboardedMember("/app/wallet");
  const { error } = await searchParams;
  const tz = member.city?.timezone;
  const [balance, membership, ledger, packs] = await Promise.all([
    getBalance(member.id),
    getMembership(member.id),
    getLedger(member.id, { take: 50 }),
    prisma.keyPack.findMany({ where: { isActive: true, stripePriceId: { not: null } }, orderBy: { sortOrder: "asc" } }),
  ]);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app/wallet" signOut={doSignOut} />
      {error && <Notice tone="error">{error}</Notice>}

      <section className="night-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Wallet</p>
        <p className="mt-2 flex items-baseline gap-2 font-display text-5xl">
          <KeyIcon className="h-8 w-8 text-red" />
          {balance.total}
        </p>
        <p className="mt-2 font-serif text-base italic text-ink-muted">
          {balance.planKeys} plan keys{balance.planKeysExpireAt ? ` expire ${formatDateOnly(balance.planKeysExpireAt, tz)}` : ""} ·{" "}
          {balance.purchasedKeys} purchased
        </p>
      </section>

      <section>
        <h2 className="font-display text-2xl leading-tight">
          top up<span className="text-red">.</span>
        </h2>
        <p className="mt-1 font-serif text-base italic text-ink-muted">
          {membership.canBuyPacks ? "purchased keys never expire." : "sorry, packs are for paid members. a plan is cheaper per key anyway."}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {packs.map((pack) => (
            <form key={pack.id} action={buyPackAction} className="night-card flex flex-col gap-2 p-4">
              <input type="hidden" name="keyPackId" value={pack.id} />
              <p className="flex items-center gap-1.5 font-display text-2xl">
                <KeyIcon className="h-5 w-5 text-red" /> {pack.keys}
              </p>
              <p className="text-sm text-ink-muted">{formatMoney(pack.amountCents, pack.currency)}</p>
              <button disabled={!membership.canBuyPacks} className="btn btn-primary mt-auto w-full">
                Buy
              </button>
            </form>
          ))}
          {packs.length === 0 && <p className="col-span-2 text-sm text-ink-muted">No packs on sale yet.</p>}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl leading-tight">
          history<span className="text-red">.</span>
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {ledger.rows.length === 0 && <li className="py-3 font-serif italic text-ink-muted">nothing yet — your first keys are on the way.</li>}
          {ledger.rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <p className="text-ink">{TYPE_LABEL[row.type] ?? row.type.toLowerCase()}</p>
                <p className="text-xs text-ink-muted">
                  {formatDate(row.createdAt, tz)} · {row.pool === "PLAN" ? "plan" : "purchased"}
                  {row.note ? ` · ${row.note}` : ""}
                </p>
              </div>
              <p className={`font-semibold tabular-nums ${row.amount < 0 ? "text-ink-muted" : "text-ok"}`}>
                {row.amount > 0 ? `+${row.amount}` : row.amount}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
