import type { City, Producer } from "@prisma/client";

export function ProducerForm({ producer, cities, action, submitLabel }: { producer?: Producer; cities: City[]; action: (fd: FormData) => Promise<void>; submitLabel: string }) {
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {producer && <input type="hidden" name="id" value={producer.id} />}
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Name</span>
        <input name="name" required minLength={2} maxLength={120} defaultValue={producer?.name ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">City</span>
        <select name="cityId" required defaultValue={producer?.cityId ?? (cities.length === 1 ? cities[0]!.id : "")} className="input">
          {cities.length !== 1 && <option value="" disabled>Pick a city</option>}
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Default discount % (discounted tickets)</span>
        <input name="defaultDiscountPercent" type="number" min={0} max={100} defaultValue={producer?.defaultDiscountPercent ?? ""} className="input" placeholder="e.g. 40" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Contact name</span>
        <input name="contactName" maxLength={120} defaultValue={producer?.contactName ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Contact email (settlement statements)</span>
        <input name="contactEmail" type="email" maxLength={200} defaultValue={producer?.contactEmail ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Contact phone</span>
        <input name="contactPhone" maxLength={40} defaultValue={producer?.contactPhone ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Payout details (IBAN etc.) — encrypted at rest{producer?.payoutDetailsEncrypted ? ", leave empty to keep" : ""}</span>
        <input name="payoutDetails" maxLength={500} className="input" placeholder={producer?.payoutDetailsEncrypted ? "••••• stored" : "PT50 …"} autoComplete="off" />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="usesEventOS" defaultChecked={producer?.usesEventOS ?? false} /> Uses EventOS (future direct integration)
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Notes (internal)</span>
        <textarea name="notes" rows={3} maxLength={2000} defaultValue={producer?.notes ?? ""} className="input" />
      </label>
      <div className="sm:col-span-2">
        <button className="btn btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}
