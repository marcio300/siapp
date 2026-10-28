import Link from "next/link";
import type { Offer, Event, TierCode } from "@prisma/client";
import { formatDate, formatMoney } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";

/** Hours until a private sale opens to everyone (null when open / none). */
export function hoursUntilOpen(offer: Offer, now: Date): number | null {
  if (offer.privateSaleTiers.length === 0) return null;
  if (!offer.privateSaleOpensAt) return Infinity;
  const ms = offer.privateSaleOpensAt.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 3_600_000) : null;
}

/** One-line state for an event card given the member's tier. */
export function eventTeaser(offers: Offer[], tierCode: TierCode, now: Date): { minKeys: number; privateSale: boolean; line: string | null } {
  const minKeys = offers.length ? Math.min(...offers.map((o) => o.keyCost)) : 0;
  let privateSale = false;
  let line: string | null = null;
  for (const o of offers) {
    const h = hoursUntilOpen(o, now);
    if (h === null) continue;
    privateSale = true;
    if (!o.privateSaleTiers.includes(tierCode)) {
      line = h === Infinity ? `${o.privateSaleTiers.join("/")} members first` : `opens to your tier in ${h}h`;
    } else if (!line) {
      line = `${o.privateSaleTiers.join("/")} private sale — you're in`;
    }
  }
  if (!line && tierCode === "FREE") line = offers.some((o) => o.openToFree) ? "open to free members" : "paid members only";
  return { minKeys, privateSale, line };
}

export function EventCard({ event, offers, tierCode, timezone, now }: { event: Event; offers: Offer[]; tierCode: TierCode; timezone: string; now: Date }) {
  const t = eventTeaser(offers, tierCode, now);
  const hasDiscount = offers.some((o) => o.type === "DISCOUNT_TICKET");
  return (
    <Link href={`/app/events/${event.id}`} className="night-card block overflow-hidden transition hover:border-red-soft">
      {event.imageUrls[0] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={event.imageUrls[0]} alt="" className="h-36 w-full object-cover" />
      )}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-xl leading-tight">{event.title.toLowerCase()}</p>
            <p className="mt-1 text-sm text-ink-muted">
              {formatDate(event.startsAt, timezone)}
              {event.venue ? ` · ${event.venue}` : ""}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-sm font-semibold">
            <KeyIcon className="h-3.5 w-3.5 text-red" /> {t.minKeys}
            {hasDiscount && <span className="text-xs font-normal text-ink-muted">+€</span>}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {t.privateSale && <span className="rounded-full bg-red-soft/20 px-2 py-0.5 font-semibold text-red-soft">private sale</span>}
          {offers.some((o) => o.type === "DISCOUNT_TICKET") && (
            <span className="rounded-full border border-line px-2 py-0.5 text-ink-muted">
              from {formatMoney(Math.min(...offers.filter((o) => o.type === "DISCOUNT_TICKET").map((o) => Math.round((o.faceValueCents ?? 0) * (1 - (o.discountPercent ?? 0) / 100)))))}
            </span>
          )}
          {t.line && <span className="font-serif italic text-ink-muted">{t.line}</span>}
        </div>
      </div>
    </Link>
  );
}
