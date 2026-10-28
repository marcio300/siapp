import type { Offer } from "@prisma/client";
import { AFTER_WINDOW, ALLOCATION_TYPES, OFFER_TYPES, PRIVATE_SALE_HOURS, TIER_CODES, offerFormDefaults } from "@/domain/events";

const TYPE_LABEL: Record<(typeof OFFER_TYPES)[number], string> = { FREE_TICKET: "Free ticket", DISCOUNT_TICKET: "Discounted ticket", GUESTLIST: "Guest list" };

/**
 * One form for add + edit. Every spec §6 field. Conditional fields are shown
 * always (with hints) — the server ignores the ones that don't apply to the
 * chosen type/allocation, so no client JS is needed.
 */
export function OfferForm({ eventId, timezone, offer, action, submitLabel, cancellationDefault }: { eventId: string; timezone: string; offer?: Offer; action: (fd: FormData) => Promise<void>; submitLabel: string; cancellationDefault: number }) {
  const d = offer ? offerFormDefaults(offer, timezone) : null;
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="eventId" value={eventId} />
      {offer && <input type="hidden" name="offerId" value={offer.id} />}

      <label className="flex flex-col gap-1">
        <span className="label">Name</span>
        <input name="name" required maxLength={80} defaultValue={offer?.name ?? ""} className="input" placeholder="Early entrance" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Type</span>
        <select name="type" defaultValue={offer?.type ?? "FREE_TICKET"} className="input">
          {OFFER_TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Key cost</span>
        <input name="keyCost" type="number" min={0} required defaultValue={offer?.keyCost ?? 10} className="input" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="label">Face value € (discounted only)</span>
        <input name="faceValueEuros" type="number" min={0} step="0.01" defaultValue={d?.faceValueEuros ?? ""} className="input" placeholder="20.00" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Discount % (discounted only)</span>
        <input name="discountPercent" type="number" min={0} max={100} defaultValue={offer?.discountPercent ?? ""} className="input" placeholder="40" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Max per member</span>
        <input name="maxPerMember" type="number" min={1} max={100} defaultValue={offer?.maxPerMember ?? 1} className="input" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="label">Allocation</span>
        <select name="allocationType" defaultValue={offer?.allocationType ?? "CAPPED"} className="input">
          {ALLOCATION_TYPES.map((a) => (
            <option key={a} value={a}>{a === "CAPPED" ? "Capped (capacity)" : "Time window (until a time)"}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Capacity (capped)</span>
        <input name="capacity" type="number" min={1} defaultValue={offer?.capacity ?? ""} className="input" placeholder="300" />
      </label>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">Until (local time)</span>
          <input name="validUntilLocal" type="time" defaultValue={d?.validUntilLocal ?? ""} className="input" />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">After window</span>
          <select name="afterWindowBehaviour" defaultValue={offer?.afterWindowBehaviour ?? ""} className="input">
            <option value="">—</option>
            {AFTER_WINDOW.map((a) => (
              <option key={a} value={a}>{a === "REFUSE" ? "Refuse" : "Pay at the door"}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="flex flex-col gap-1 sm:col-span-3">
        <legend className="label">Private sale — tiers that get in first</legend>
        <div className="flex flex-wrap items-end gap-4">
          {TIER_CODES.filter((t) => t !== "FREE").map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="privateSaleTiers" value={t} defaultChecked={offer?.privateSaleTiers.includes(t) ?? false} /> {t}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <span className="label">for</span>
            <select name="privateSaleHoursBefore" defaultValue={offer?.privateSaleHoursBefore ?? ""} className="input w-28">
              <option value="">—</option>
              {PRIVATE_SALE_HOURS.map((h) => (
                <option key={h} value={h}>{h} h</option>
              ))}
            </select>
            <span className="text-xs text-ink-dark-muted">after publish</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="label">or opens to all at</span>
            <input name="privateSaleOpensAtDate" type="date" defaultValue={d?.privateSaleOpensAt.date ?? ""} className="input w-40" />
            <input name="privateSaleOpensAtTime" type="time" defaultValue={d?.privateSaleOpensAt.time ?? ""} className="input w-28" />
          </label>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="openToFree" defaultChecked={offer?.openToFree ?? false} /> Open to FREE tier
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="plusOneAllowed" defaultChecked={offer?.plusOneAllowed ?? false} /> +1 allowed
      </label>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">+1 extra keys</span>
          <input name="plusOneExtraKeyCost" type="number" min={0} defaultValue={offer?.plusOneExtraKeyCost ?? 0} className="input" />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">+1 extra €</span>
          <input name="plusOneExtraCashEuros" type="number" min={0} step="0.01" defaultValue={d?.plusOneExtraCashEuros ?? ""} className="input" />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="label">Cancel until (h before start) — empty = global {cancellationDefault}</span>
        <input name="cancellationWindowHours" type="number" min={0} max={720} defaultValue={offer?.cancellationWindowHours ?? ""} className="input" />
      </label>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">Redeem from (empty = publish)</span>
          <div className="flex gap-1">
            <input name="redeemFromDate" type="date" defaultValue={d?.redeemFrom.date ?? ""} className="input" />
            <input name="redeemFromTime" type="time" defaultValue={d?.redeemFrom.time ?? ""} className="input w-28" />
          </div>
        </label>
      </div>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">Redeem until (empty = event start)</span>
          <div className="flex gap-1">
            <input name="redeemUntilDate" type="date" defaultValue={d?.redeemUntil.date ?? ""} className="input" />
            <input name="redeemUntilTime" type="time" defaultValue={d?.redeemUntil.time ?? ""} className="input w-28" />
          </div>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="label">Sort order</span>
        <input name="sortOrder" type="number" min={0} defaultValue={offer?.sortOrder ?? 0} className="input w-24" />
      </label>
      <div className="flex items-end sm:col-span-2">
        <button className="btn btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}
