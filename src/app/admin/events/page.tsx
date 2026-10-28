import Link from "next/link";
import type { EventStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { offerCounters } from "@/domain/events";
import { formatDate } from "@/lib/format";
import { utcToLocal } from "@/lib/time";
import { Badge, statusTone } from "@/components/backoffice/badge";
import { PageHeader } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { KeyIcon } from "@/components/key-icon";

const STATUSES: EventStatus[] = ["DRAFT", "PUBLISHED", "CANCELLED", "FINISHED"];

export default async function EventsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireStaffPage("OPS");
  const sp = await searchParams;
  const cities = await prisma.city.findMany({ orderBy: { name: "asc" } });
  const status = STATUSES.includes(sp.status as EventStatus) ? (sp.status as EventStatus) : undefined;
  const from = sp.from ? new Date(`${sp.from}T00:00:00Z`) : undefined;
  const to = sp.to ? new Date(`${sp.to}T23:59:59Z`) : undefined;
  const past = sp.past === "1";
  const events = await prisma.event.findMany({
    where: {
      ...(sp.cityId ? { cityId: sp.cityId } : {}),
      ...(status ? { status } : {}),
      ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : !past ? { endsAt: { gte: new Date() } } : {}),
    },
    include: { producer: true, city: true, offers: { orderBy: { sortOrder: "asc" } } },
    orderBy: { startsAt: past ? "desc" : "asc" },
    take: 200,
  });
  const counters = await offerCounters(events.flatMap((e) => e.offers.map((o) => o.id)));

  return (
    <>
      <PageHeader
        title="Events"
        subtitle={`${events.length} ${events.length === 1 ? "event" : "events"}${!from && !to && !past ? " upcoming" : ""}`}
        actions={<Link href="/admin/events/new" className="btn btn-primary">New event</Link>}
      />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <select name="cityId" defaultValue={sp.cityId ?? ""} className="input w-auto">
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ""} className="input w-auto">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.toLowerCase()}</option>
          ))}
        </select>
        <input name="from" type="date" defaultValue={sp.from ?? ""} className="input w-auto" />
        <input name="to" type="date" defaultValue={sp.to ?? ""} className="input w-auto" />
        <label className="flex items-center gap-1 text-sm text-ink-dark-muted"><input type="checkbox" name="past" value="1" defaultChecked={past} /> include past</label>
        <button className="btn btn-outline">Filter</button>
        {(sp.cityId || status || from || to || past) && <Link href="/admin/events" className="btn btn-ghost">Clear</Link>}
      </form>
      <Table>
        <thead>
          <tr>
            <Th>Event</Th>
            <Th>Starts</Th>
            <Th>Status</Th>
            <Th>Offers · redeemed / allocation</Th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && <EmptyRow colSpan={4}>No events match.</EmptyRow>}
          {events.map((e) => (
            <tr key={e.id}>
              <Td>
                <Link href={`/admin/events/${e.id}`} className="font-medium hover:text-red">{e.title}</Link>
                <div className="text-xs text-ink-dark-muted">{e.producer.name} · {e.city.name}{e.venue ? ` · ${e.venue}` : ""}</div>
              </Td>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(e.startsAt, e.city.timezone)}</Td>
              <Td><Badge tone={statusTone(e.status)}>{e.status.toLowerCase()}</Badge></Td>
              <Td>
                {e.offers.length === 0 && <span className="text-ink-dark-muted">no offers</span>}
                <ul className="space-y-0.5 text-xs">
                  {e.offers.map((o) => {
                    const c = counters.get(o.id)!;
                    return (
                      <li key={o.id} className="flex items-center gap-2">
                        <span className="font-medium">{o.name}</span>
                        <span className="inline-flex items-center gap-0.5 text-ink-dark-muted"><KeyIcon className="h-3 w-3 text-red" />{o.keyCost}</span>
                        <span className="tabular-nums">
                          {o.allocationType === "CAPPED" ? `${c.redeemed} / ${o.capacity}` : `${c.redeemed} · until ${o.validUntil ? utcToLocal(o.validUntil, e.city.timezone).time : "?"}`}
                        </span>
                        {o.privateSaleTiers.length > 0 && <Badge tone="warn">private sale</Badge>}
                      </li>
                    );
                  })}
                </ul>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
