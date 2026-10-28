import type { Event, Producer } from "@prisma/client";
import { eventFormDefaults } from "@/domain/events";

export function EventForm({
  event,
  timezone,
  producers,
  defaultProducerId,
  action,
  submitLabel,
}: {
  event?: Event;
  timezone: string;
  producers: (Producer & { city: { name: string; timezone: string } })[];
  defaultProducerId?: string;
  action: (fd: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const d = event ? eventFormDefaults(event, timezone) : null;
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {event && <input type="hidden" name="id" value={event.id} />}
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Title</span>
        <input name="title" required minLength={2} maxLength={140} defaultValue={event?.title ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Producer (sets the city)</span>
        <select name="producerId" required defaultValue={event?.producerId ?? defaultProducerId ?? ""} className="input">
          <option value="" disabled>Pick a producer</option>
          {producers.map((p) => (
            <option key={p.id} value={p.id}>{p.name} · {p.city.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Venue</span>
        <input name="venue" maxLength={140} defaultValue={event?.venue ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Address</span>
        <input name="address" maxLength={240} defaultValue={event?.address ?? ""} className="input" />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="label">Starts (local time, {timezone})</legend>
        <div className="flex gap-2">
          <input name="startsAtDate" type="date" required defaultValue={d?.startsAt.date ?? ""} className="input" />
          <input name="startsAtTime" type="time" required defaultValue={d?.startsAt.time ?? "23:00"} className="input w-32" />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="label">Ends (local time)</legend>
        <div className="flex gap-2">
          <input name="endsAtDate" type="date" required defaultValue={d?.endsAt.date ?? ""} className="input" />
          <input name="endsAtTime" type="time" required defaultValue={d?.endsAt.time ?? "06:00"} className="input w-32" />
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Description</span>
        <textarea name="description" rows={4} maxLength={5000} defaultValue={event?.description ?? ""} className="input" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Image URLs (one per line, max 10)</span>
        <textarea name="imageUrls" rows={3} defaultValue={event?.imageUrls.join("\n") ?? ""} className="input font-mono text-xs" placeholder="https://…" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Tags (comma-separated)</span>
        <input name="tags" defaultValue={event?.tags.join(", ") ?? ""} className="input" placeholder="techno, rooftop" />
      </label>
      <div className="sm:col-span-2">
        <button className="btn btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}
