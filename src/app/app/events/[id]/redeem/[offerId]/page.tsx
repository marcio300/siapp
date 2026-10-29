import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireOnboardedMember } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getBalance } from "@/domain/keys";
import { explainEligibility, offerCost } from "@/domain/redemption";
import { formatDate, formatMoney } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";
import { Wordmark } from "@/components/wordmark";
import { redeemAction } from "../../../actions";

/** Redeem sheet: keys breakdown, +1 name, price for discounted tickets, one confirm. */
export default async function RedeemPage({ params }: { params: Promise<{ id: string; offerId: string }> }) {
  const member = await requireOnboardedMember();
  const { id, offerId } = await params;
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { event: { include: { city: true, producer: { select: { name: true } } } } } });
  if (!offer || offer.eventId !== id) notFound();
  const elig = await explainEligibility(member.id, offerId);
  if (!elig.ok) redirect(`/app/events/${id}?error=${encodeURIComponent(elig.message)}`);
  const balance = await getBalance(member.id);
  const base = offerCost(offer, false);
  const withPlus = offer.plusOneAllowed ? offerCost(offer, true) : null;
  const breakdown = (cost: number) => ({ fromPlan: Math.min(balance.planKeys, cost), fromPurchased: Math.max(cost - balance.planKeys, 0) });
  const b = breakdown(base.keyCost);
  const tz = offer.event.city.timezone;
  const cancelDeadline = new Date(offer.event.startsAt.getTime() - (offer.cancellationWindowHours ?? 24) * 3_600_000);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-8">
      <Wordmark />
      <Link href={`/app/events/${id}`} className="mt-6 text-sm text-ink-muted hover:text-ink">← back</Link>
      <h1 className="mt-4 font-display text-3xl leading-tight">{offer.event.title.toLowerCase()}</h1>
      <p className="text-ink-muted">{offer.name} · {formatDate(offer.event.startsAt, tz)}</p>

      <form action={redeemAction} className="night-card mt-6 flex flex-col gap-4 p-5">
        <input type="hidden" name="eventId" value={id} />
        <input type="hidden" name="offerId" value={offer.id} />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">You spend</p>
          <p className="mt-1 flex items-center gap-2 font-display text-4xl"><KeyIcon className="h-7 w-7 text-red" />{base.keyCost}</p>
          <p className="font-serif italic text-ink-muted">
            {b.fromPlan} plan keys{b.fromPurchased > 0 ? ` + ${b.fromPurchased} purchased` : ""} · {balance.total - base.keyCost} left after
          </p>
          {base.cashCents > 0 && (
            <p className="mt-2 text-sm">
              plus <span className="font-semibold">{formatMoney(base.cashCents)}</span> by card <span className="text-ink-muted">({offer.discountPercent}% off {formatMoney(offer.faceValueCents ?? 0)})</span>
            </p>
          )}
        </div>
        {offer.plusOneAllowed && withPlus && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Bringing a +1? <span className="normal-case tracking-normal">(+{offer.plusOneExtraKeyCost} keys{offer.plusOneExtraCashCents ? ` + ${formatMoney(offer.plusOneExtraCashCents)}` : ""}; they&apos;re scanned with you)</span>
            </span>
            <input name="plusOneName" maxLength={80} className="input-dark" placeholder="their full name, as on their ID" />
          </label>
        )}
        <p className="text-xs text-ink-muted">
          cancel for a full refund until {formatDate(cancelDeadline, tz)}. after that it&apos;s final — a no-show costs the keys.
          {base.cashCents > 0 ? " card payment opens next; your spot is held for 10 minutes." : ""}
        </p>
        {base.cashCents > 0 && (
          <p className="text-xs text-ink-muted">
            you&apos;re paying SIAPP, the seller of record, on behalf of {offer.event.producer.name}: we take the payment, issue the ticket and handle refunds; the producer gets its share after the door scans you. price includes VAT. <Link href="/legal/terms" className="underline">terms</Link>.
          </p>
        )}
        <button className="btn btn-primary w-full">{base.cashCents > 0 ? `Pay ${formatMoney(base.cashCents)} and get in` : "Redeem — I'm in"}</button>
      </form>
    </main>
  );
}
