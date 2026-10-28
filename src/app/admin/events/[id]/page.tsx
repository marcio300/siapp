import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { offerCounters } from "@/domain/events";
import { getSetting } from "@/lib/settings";
import { formatDate, formatMoney } from "@/lib/format";
import { utcToLocal } from "@/lib/time";
import { Badge, statusTone } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { KeyIcon } from "@/components/key-icon";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { addOfferAction, deleteOfferAction, duplicateEventAction, regeneratePinAction, setEventStatusAction, updateEventAction, updateOfferAction } from "../actions";
import { EventForm } from "../event-form";
import { OfferForm } from "../offer-form";

export default async function EventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const event = await prisma.event.findUnique({ where: { id }, include: { producer: true, city: true, offers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } });
  if (!event) notFound();
  const tz = event.city.timezone;
  const [producers, counters, cancellationDefault] = await Promise.all([
    prisma.producer.findMany({ where: { cityId: event.cityId }, include: { city: true }, orderBy: { name: "asc" } }),
    offerCounters(event.offers.map((o) => o.id)),
    getSetting("cancellation_window_hours"),
  ]);
  const closed = event.status === "FINISHED" || event.status === "CANCELLED";
  const redemptions = await prisma.redemption.findMany({ where: { eventId: event.id }, include: { member: { select: { id: true, name: true, email: true } }, offer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 300 });
  const scans = await prisma.scan.findMany({ where: { eventId: event.id }, include: { ticket: { select: { memberName: true, plusOneName: true, redemption: { select: { memberId: true } } } } }, orderBy: { scannedAt: "desc" }, take: 100 });
  const scanTotals = { ok: scans.filter((s) => s.result === "OK").length, disputed: scans.filter((s) => s.disputed).length };

  return (
    <>
      <PageHeader
        title={event.title}
        subtitle={
          <>
            {event.producer.name} · {event.city.name} · {formatDate(event.startsAt, tz)} → {formatDate(event.endsAt, tz)} ·{" "}
            <Badge tone={statusTone(event.status)}>{event.status.toLowerCase()}</Badge>
            {event.publishedAt && <> · published {formatDate(event.publishedAt, tz)}</>}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {event.status === "DRAFT" && (
              <form action={setEventStatusAction}><input type="hidden" name="id" value={event.id} /><input type="hidden" name="status" value="PUBLISHED" /><button className="btn btn-primary">Publish</button></form>
            )}
            {event.status === "PUBLISHED" && (
              <>
                <form action={setEventStatusAction}><input type="hidden" name="id" value={event.id} /><input type="hidden" name="status" value="DRAFT" /><button className="btn btn-outline">Unpublish</button></form>
                <form action={setEventStatusAction}><input type="hidden" name="id" value={event.id} /><input type="hidden" name="status" value="FINISHED" /><button className="btn btn-outline">Finish</button></form>
                <form action={setEventStatusAction}><input type="hidden" name="id" value={event.id} /><input type="hidden" name="status" value="CANCELLED" /><button className="btn btn-outline text-red">Cancel event</button></form>
              </>
            )}
            <form action={duplicateEventAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={event.id} />
              <input name="shiftDays" type="number" defaultValue={7} className="input w-20 !py-1" title="shift dates by N days" />
              <button className="btn btn-outline">Duplicate</button>
            </form>
            <Link href="/admin/events" className="btn btn-ghost">← Events</Link>
          </div>
        }
      />
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {(sp.saved || sp.created || sp.status || sp.offer) && !sp.error && (
        <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">
          {sp.created ? "Event created as a draft." : sp.status ? `Event is now ${sp.status}.` : sp.offer ? `Offer ${sp.offer}.` : "Saved."}
        </p>
      )}
      {sp.pin && (
        <div className="mb-4 rounded-xl border-2 border-red bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-red">Scanner PIN — shown once, write it down</p>
          <p className="mt-1 font-display text-3xl tracking-widest">{sp.pin}</p>
          <p className="text-xs text-ink-dark-muted">Door staff sign in to the scanner with code <span className="font-mono">{event.scannerCode}</span> and this PIN. It is not stored in clear; regenerate if lost.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          {closed ? <p className="text-sm text-ink-dark-muted">This event is {event.status.toLowerCase()} — details are frozen.</p> : <EventForm event={event} timezone={tz} producers={producers} action={updateEventAction} submitLabel="Save" />}
        </div>
        <div className="card p-5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Scanner login</p>
          <p className="mt-2">Code <span className="font-mono text-base font-semibold">{event.scannerCode}</span></p>
          <p className="text-xs text-ink-dark-muted">PIN: shown once at creation. Hand both to the door.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={regeneratePinAction}>
              <input type="hidden" name="id" value={event.id} />
              <button className="btn btn-outline !py-1 text-xs">Regenerate PIN</button>
            </form>
            <Link href="/scan" target="_blank" className="btn btn-outline !py-1 text-xs">Open scanner ↗</Link>
          </div>
          <p className="mt-2 text-xs text-ink-dark-muted">{counters.size > 0 ? `${Array.from(counters.values()).reduce((n, c) => n + c.checkedIn, 0)} checked in` : "No offers yet"}{scanTotals.disputed > 0 ? ` · ${scanTotals.disputed} disputed` : ""}</p>
          {event.imageUrls[0] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.imageUrls[0]} alt="" className="mt-4 h-28 w-full rounded-lg object-cover" />
          )}
          {event.tags.length > 0 && <p className="mt-3 text-xs text-ink-dark-muted">{event.tags.map((t) => `#${t}`).join(" ")}</p>}
        </div>
      </div>

      <div className="mt-8" id="offers">
        <SectionTitle>Offers · {event.offers.length}</SectionTitle>
        <div className="flex flex-col gap-3">
          {event.offers.length === 0 && <p className="card p-5 text-sm text-ink-dark-muted">No offers yet — an event needs at least one to publish.</p>}
          {event.offers.map((o) => {
            const c = counters.get(o.id)!;
            return (
              <details key={o.id} className="card">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <span className="font-semibold">{o.name}</span>
                  <Badge>{o.type.toLowerCase().replace("_", " ")}</Badge>
                  <span className="inline-flex items-center gap-1"><KeyIcon className="h-3.5 w-3.5 text-red" />{o.keyCost}{o.plusOneAllowed ? ` (+1: ${o.plusOneExtraKeyCost}${o.plusOneExtraCashCents ? ` + ${formatMoney(o.plusOneExtraCashCents)}` : ""})` : ""}</span>
                  {o.type === "DISCOUNT_TICKET" && <span className="text-ink-dark-muted">{formatMoney(o.faceValueCents ?? 0)} −{o.discountPercent}% = {formatMoney(Math.round((o.faceValueCents ?? 0) * (1 - (o.discountPercent ?? 0) / 100)))}</span>}
                  <span className="tabular-nums">
                    {o.allocationType === "CAPPED" ? `${c.redeemed} / ${o.capacity} redeemed` : `${c.redeemed} redeemed · until ${o.validUntil ? utcToLocal(o.validUntil, tz).time : "?"} (${o.afterWindowBehaviour === "PAY_DOOR" ? "pay at door after" : "refuse after"})`}
                    {c.checkedIn > 0 ? ` · ${c.checkedIn} in` : ""}
                  </span>
                  {o.privateSaleTiers.length > 0 && (
                    <Badge tone="warn">
                      private sale {o.privateSaleTiers.join("/")}{o.privateSaleOpensAt ? ` → opens ${formatDate(o.privateSaleOpensAt, tz)}` : o.privateSaleHoursBefore ? ` · ${o.privateSaleHoursBefore} h after publish` : ""}
                    </Badge>
                  )}
                  {o.openToFree && <Badge tone="ok">free tier ok</Badge>}
                </summary>
                <div className="border-t border-line-light px-5 py-4">
                  {closed ? (
                    <p className="text-sm text-ink-dark-muted">Frozen.</p>
                  ) : (
                    <>
                      <OfferForm eventId={event.id} timezone={tz} offer={o} action={updateOfferAction} submitLabel="Save offer" cancellationDefault={cancellationDefault} />
                      <form action={deleteOfferAction} className="mt-3">
                        <input type="hidden" name="eventId" value={event.id} />
                        <input type="hidden" name="offerId" value={o.id} />
                        <button className="btn btn-ghost text-xs text-red">Delete offer</button>
                      </form>
                    </>
                  )}
                </div>
              </details>
            );
          })}
        </div>
        {!closed && (
          <div className="card mt-4 p-5" id="add-offer">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Add offer</p>
            <OfferForm eventId={event.id} timezone={tz} action={addOfferAction} submitLabel="Add offer" cancellationDefault={cancellationDefault} />
          </div>
        )}
      </div>
      <div className="mt-8">
        <SectionTitle>Redemptions · {redemptions.length}</SectionTitle>
        <Table>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Offer</Th>
              <Th>Status</Th>
              <Th>+1</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {redemptions.length === 0 && <EmptyRow colSpan={5}>No redemptions yet.</EmptyRow>}
            {redemptions.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/admin/members/${r.member.id}`} className="hover:text-red">{r.member.name ?? r.member.email}</Link></Td>
                <Td>{r.offer.name}</Td>
                <Td><Badge tone={statusTone(r.status)}>{r.status.toLowerCase().replace("_", " ")}</Badge></Td>
                <Td className="text-ink-dark-muted">{r.plusOneName ?? "—"}</Td>
                <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(r.createdAt, tz)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <div className="mt-8">
        <SectionTitle>Door log · {scans.length}{scans.length === 100 ? "+" : ""} scans · {scanTotals.ok} admitted</SectionTitle>
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Result</Th>
              <Th>Ticket</Th>
              <Th>Door</Th>
              <Th>Dispute</Th>
            </tr>
          </thead>
          <tbody>
            {scans.length === 0 && <EmptyRow colSpan={5}>Nothing scanned yet.</EmptyRow>}
            {scans.map((s) => (
              <tr key={s.id} className={s.disputed ? "bg-warn/10" : undefined}>
                <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(s.scannedAt, tz)}</Td>
                <Td><Badge tone={s.result === "OK" ? "ok" : s.result === "ALREADY_SCANNED" || s.result === "WINDOW_CLOSED" ? "warn" : "red"}>{s.result.toLowerCase().replace("_", " ")}</Badge></Td>
                <Td>
                  {s.ticket ? (
                    <Link href={`/admin/members/${s.ticket.redemption.memberId}`} className="hover:text-red">{s.ticket.memberName}{s.ticket.plusOneName ? ` +1 ${s.ticket.plusOneName}` : ""}</Link>
                  ) : (
                    <span className="font-mono text-xs text-ink-dark-muted">{s.rawPayload ? `${s.rawPayload.slice(0, 16)}…` : "—"}</span>
                  )}
                </Td>
                <Td className="text-ink-dark-muted">{s.scannedBy ?? "—"}</Td>
                <Td className="text-ink-dark-muted">{s.disputed ? s.disputeNote : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
