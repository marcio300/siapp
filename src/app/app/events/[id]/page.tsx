import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOnboardedMember } from "@/lib/authz";
import { signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getMembership } from "@/domain/billing";
import { getBalance } from "@/domain/keys";
import { COUNTING, checkEligibility, offerCost, reservedSeats, type Eligibility } from "@/domain/redemption";
import { formatDate, formatMoney } from "@/lib/format";
import { utcToLocal } from "@/lib/time";
import { KeyIcon } from "@/components/key-icon";
import { MemberHeader, Notice } from "@/components/member-nav";
import { hoursUntilOpen } from "@/components/event-card";
import { joinWaitlistAction, leaveWaitlistAction } from "../actions";

function reasonCopy(e: Eligibility & { ok: false }, tz: string): string {
  switch (e.reason) {
    case "PRIVATE_SALE": {
      const opens = e.detail.opensAt ? new Date(String(e.detail.opensAt)) : null;
      if (!opens) return e.message;
      const h = Math.ceil((opens.getTime() - Date.now()) / 3_600_000);
      return `opens to your tier in ${h}h (${formatDate(opens, tz)})`;
    }
    case "OFFER_NOT_OPEN":
      return `opens ${formatDate(new Date(String(e.detail.opensAt)), tz)}`;
    default:
      return e.message.toLowerCase();
  }
}

export default async function EventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await requireOnboardedMember();
  const { id } = await params;
  const sp = await searchParams;
  const now = new Date();
  const event = await prisma.event.findUnique({ where: { id }, include: { city: true, producer: true, offers: { orderBy: { sortOrder: "asc" } } } });
  if (!event || (event.status !== "PUBLISHED" && event.status !== "FINISHED" && event.status !== "CANCELLED")) notFound();
  const tz = event.city.timezone;
  const [membership, balance] = await Promise.all([getMembership(member.id), getBalance(member.id)]);

  const rows = await Promise.all(
    event.offers.map(async (offer) => {
      const [used, reservedForOthers, ownCount, waitlist] = await Promise.all([
        prisma.redemption.count({ where: { offerId: offer.id, status: { in: COUNTING } } }),
        reservedSeats(prisma, offer.id, now, member.id),
        prisma.redemption.count({ where: { offerId: offer.id, memberId: member.id, status: { in: COUNTING } } }),
        prisma.waitlistEntry.findUnique({ where: { offerId_memberId: { offerId: offer.id, memberId: member.id } } }),
      ]);
      const elig = checkEligibility({ now, member, tierCode: membership.tierCode, isPaid: membership.isPaid, balanceTotal: balance.total, offer: { ...offer, event }, used, reservedForOthers, ownCount, plusOne: false });
      const own = ownCount > 0 ? await prisma.redemption.findFirst({ where: { offerId: offer.id, memberId: member.id, status: { in: COUNTING } }, select: { id: true, status: true } }) : null;
      return { offer, elig, used, waitlist, own };
    }),
  );

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app" signOut={doSignOut} />
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {sp.waitlist === "joined" && <Notice tone="ok">you&apos;re on the waitlist. we&apos;ll email you the moment a spot opens — you&apos;ll have a short window to grab it.</Notice>}
      {sp.waitlist === "left" && <Notice tone="ok">off the waitlist.</Notice>}

      {event.imageUrls[0] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={event.imageUrls[0]} alt="" className="h-48 w-full rounded-2xl object-cover" />
      )}
      <section>
        <h1 className="font-display text-3xl leading-tight">{event.title.toLowerCase()}</h1>
        <p className="mt-2 text-ink-muted">
          {formatDate(event.startsAt, tz)} → {utcToLocal(event.endsAt, tz).time}
          {event.venue ? ` · ${event.venue}` : ""}
        </p>
        {event.address && <p className="text-sm text-ink-muted">{event.address}</p>}
        <p className="mt-1 text-xs text-ink-muted">by {event.producer.name}</p>
        {event.description && <p className="mt-4 whitespace-pre-line text-sm text-ink">{event.description}</p>}
        {event.status !== "PUBLISHED" && <p className="mt-4 font-serif text-lg italic text-ink-muted">this one is {event.status.toLowerCase()}.</p>}
      </section>

      <section className="flex flex-col gap-3">
        {rows.map(({ offer, elig, used, waitlist, own }) => {
          const cost = offerCost(offer, false);
          const privateH = hoursUntilOpen(offer, now);
          const soldOut = !elig.ok && (elig.reason === "SOLD_OUT" || elig.reason === "WAITLIST_ONLY");
          const onWaitlist = waitlist && (waitlist.status === "WAITING" || waitlist.status === "NOTIFIED");
          return (
            <div key={offer.id} className="night-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-display text-xl">{offer.name.toLowerCase()}</p>
                  <p className="text-xs text-ink-muted">
                    {offer.type === "FREE_TICKET" ? "free ticket" : offer.type === "GUESTLIST" ? "guest list" : "discounted ticket"}
                    {offer.allocationType === "CAPPED" && offer.capacity !== null ? ` · ${Math.max(offer.capacity - used, 0)} left` : offer.validUntil ? ` · free entry until ${utcToLocal(offer.validUntil, tz).time}${offer.afterWindowBehaviour === "PAY_DOOR" ? ", door price after" : ""}` : ""}
                    {offer.plusOneAllowed ? ` · +1 ok (+${offer.plusOneExtraKeyCost} keys${offer.plusOneExtraCashCents ? ` + ${formatMoney(offer.plusOneExtraCashCents)}` : ""})` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="inline-flex items-center gap-1 font-display text-2xl"><KeyIcon className="h-5 w-5 text-red" />{cost.keyCost}</p>
                  {cost.cashCents > 0 && (
                    <p className="text-xs text-ink-muted"><s>{formatMoney(offer.faceValueCents ?? 0)}</s> {formatMoney(cost.cashCents)}</p>
                  )}
                </div>
              </div>
              {privateH !== null && (
                <p className="mt-2 inline-block rounded-full bg-red-soft/20 px-2 py-0.5 text-xs font-semibold text-red-soft">
                  private sale · {offer.privateSaleTiers.join("/")}{privateH !== Infinity ? ` · opens to all in ${privateH}h` : ""}
                </p>
              )}
              <div className="mt-3">
                {own ? (
                  <Link href={`/app/tickets/${own.id}`} className="btn w-full border border-line text-ink">
                    {own.status === "ACTIVE" ? "You're in — open ticket" : own.status === "PENDING_PAYMENT" ? "Finish paying" : "Under review — open ticket"}
                  </Link>
                ) : elig.ok ? (
                  <Link href={`/app/events/${event.id}/redeem/${offer.id}`} className="btn btn-primary w-full">
                    Redeem for {cost.keyCost} keys{cost.cashCents > 0 ? ` + ${formatMoney(cost.cashCents)}` : ""}
                  </Link>
                ) : soldOut ? (
                  onWaitlist ? (
                    <form action={leaveWaitlistAction} className="flex items-center justify-between gap-3">
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="offerId" value={offer.id} />
                      <span className="font-serif italic text-ink-muted">{waitlist!.status === "NOTIFIED" ? "a spot is yours — redeem now!" : "you're on the waitlist."}</span>
                      <button className="text-xs text-ink-muted hover:text-ink">leave</button>
                    </form>
                  ) : (
                    <form action={joinWaitlistAction}>
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="offerId" value={offer.id} />
                      <button className="btn w-full border border-line text-ink">Sorry, it&apos;s full — join the waitlist</button>
                    </form>
                  )
                ) : (
                  <p className="font-serif italic text-ink-muted">
                    sorry, {reasonCopy(elig, tz)}
                    {elig.reason === "NOT_VERIFIED" && elig.detail.nextStep ? <> · <Link href={String(elig.detail.nextStep)} className="underline">fix it</Link></> : null}
                    {elig.reason === "INSUFFICIENT_KEYS" ? <> · <Link href="/app/wallet" className="underline">top up</Link></> : null}
                    {elig.reason === "TIER_NOT_ALLOWED" ? <> · <Link href="/app/membership" className="underline">pick a plan</Link></> : null}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
