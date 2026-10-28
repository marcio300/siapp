import Link from "next/link";
import { requireMemberPage } from "@/lib/authz";
import { Wordmark } from "@/components/wordmark";

/**
 * Where Stripe Checkout sends the member back. Nothing is read from the
 * session here on purpose: fulfilment is webhook-only (CLAUDE.md rule 12),
 * so this page only says what happens next.
 */
export default async function BillingReturnPage() {
  await requireMemberPage("/app/wallet");
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-8">
      <Wordmark />
      <section className="night-card mt-10 p-6">
        <h1 className="font-display text-3xl leading-tight">
          you&apos;re in<span className="text-red">.</span>
        </h1>
        <p className="mt-2 font-serif text-lg italic text-ink-muted">
          payment received. your keys land as soon as Stripe confirms — usually before you finish reading this.
        </p>
        <div className="mt-6 flex gap-2">
          <Link href="/app/wallet" className="btn btn-primary">
            Open wallet
          </Link>
          <Link href="/app/membership" className="btn border border-line text-ink-muted hover:text-ink">
            Membership
          </Link>
        </div>
      </section>
    </main>
  );
}
