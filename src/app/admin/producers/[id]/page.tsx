import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { payoutDetails } from "@/domain/producers";
import { formatDate } from "@/lib/format";
import { Badge, statusTone } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { clearPayoutAction, updateProducerAction } from "../actions";
import { ProducerForm } from "../producer-form";

export default async function ProducerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string; reveal?: string }> }) {
  const staff = await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const producer = await prisma.producer.findUnique({ where: { id }, include: { city: true, events: { orderBy: { startsAt: "desc" }, take: 20 } } });
  if (!producer) notFound();
  const cities = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const reveal = staff.role === "ADMIN" && sp.reveal === "1";
  const payout = payoutDetails(producer.payoutDetailsEncrypted, reveal);

  return (
    <>
      <PageHeader title={producer.name} subtitle={`${producer.city.name} · ${producer.events.length} recent events`} actions={<Link href="/admin/producers" className="btn btn-ghost">← Producers</Link>} />
      {sp.saved && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Saved.</p>}
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <ProducerForm producer={producer} cities={cities} action={updateProducerAction} submitLabel="Save" />
        </div>
        <div className="card p-5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Payout details</p>
          {payout.masked ? (
            <>
              <p className="mt-2 font-mono">{payout.full ?? payout.masked}</p>
              {staff.role === "ADMIN" && (
                <div className="mt-3 flex gap-2">
                  {!reveal && <Link href={`/admin/producers/${producer.id}?reveal=1`} className="btn btn-outline !py-1 text-xs">Reveal</Link>}
                  <form action={clearPayoutAction}>
                    <input type="hidden" name="id" value={producer.id} />
                    <button className="btn btn-outline !py-1 text-xs text-red">Clear</button>
                  </form>
                </div>
              )}
            </>
          ) : (
            <p className="mt-2 text-ink-dark-muted">none on file — settlements can't be paid out</p>
          )}
          <p className="mt-3 text-xs text-ink-dark-muted">Encrypted at rest. Only ADMIN can reveal.</p>
        </div>
      </div>

      <div className="mt-8">
        <SectionTitle>Events</SectionTitle>
        <Table>
          <thead>
            <tr>
              <Th>Event</Th>
              <Th>Starts</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {producer.events.length === 0 && <EmptyRow colSpan={3}>No events yet — <Link href={`/admin/events/new?producerId=${producer.id}`} className="underline">create one</Link>.</EmptyRow>}
            {producer.events.map((e) => (
              <tr key={e.id}>
                <Td><Link href={`/admin/events/${e.id}`} className="font-medium hover:text-red">{e.title}</Link></Td>
                <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(e.startsAt, producer.city.timezone)}</Td>
                <Td><Badge tone={statusTone(e.status)}>{e.status.toLowerCase()}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
