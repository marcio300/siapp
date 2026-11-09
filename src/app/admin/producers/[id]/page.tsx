import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { payoutDetails } from "@/domain/producers";
import { formatDate } from "@/lib/format";
import { Badge, statusTone } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { formatMoney } from "@/lib/format";
import { SettlementRow } from "@/app/admin/settlements/settlement-row";
import { clearPayoutAction, generateApiKeyAction, revokeApiKeyAction, unbindEventOSAction, updateProducerAction } from "../actions";
import { ProducerForm } from "../producer-form";

export default async function ProducerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string; reveal?: string; paid?: string; reopened?: string; sent?: string; apiKey?: string }> }) {
  const staff = await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const producer = await prisma.producer.findUnique({ where: { id }, include: { city: true, events: { orderBy: { startsAt: "desc" }, take: 20 }, apiKeys: { orderBy: { createdAt: "desc" }, take: 5 } } });
  if (!producer) notFound();
  const activeKey = producer.apiKeys.find((k) => !k.revokedAt) ?? null;
  const cities = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const settlements = await prisma.settlement.findMany({
    where: { producerId: producer.id },
    include: { producer: { select: { id: true, name: true, contactEmail: true } }, event: { select: { id: true, title: true, startsAt: true, source: true, city: { select: { timezone: true } } } }, _count: { select: { lines: true } } },
    orderBy: [{ status: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const openCents = settlements.filter((s) => s.status === "OPEN").reduce((n, s) => n + s.amountCents, 0);
  const reveal = staff.role === "ADMIN" && sp.reveal === "1";
  const payout = payoutDetails(producer.payoutDetailsEncrypted, reveal);

  return (
    <>
      <PageHeader title={producer.name} subtitle={`${producer.city.name} · ${producer.events.length} recent events`} actions={<Link href="/admin/producers" className="btn btn-ghost">← Producers</Link>} />
      {(sp.saved || sp.paid || sp.reopened || sp.sent) && !sp.error && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">{sp.paid ? "Marked paid." : sp.reopened ? "Reopened." : sp.sent ? "Statement sent." : "Saved."}</p>}
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {sp.apiKey && (
        <div className="mb-4 rounded-xl border-2 border-red bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-red">EventOS API key — shown once, hand it to the producer</p>
          <p className="mt-1 break-all font-mono text-sm">{sp.apiKey}</p>
          <p className="text-xs text-ink-dark-muted">They paste it in EventOS → Settings → SIAPP. We only store a hash; generate a new one if it is lost (the old one stops working).</p>
        </div>
      )}

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

      <div className="card mt-4 p-5 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">EventOS connection</p>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          <div>
            <p className="text-xs text-ink-dark-muted">API key</p>
            {activeKey ? (
              <p className="font-mono">siapp_pk_{activeKey.prefix}_…</p>
            ) : (
              <p className="text-ink-dark-muted">none — the producer can't connect yet</p>
            )}
            {activeKey && <p className="text-xs text-ink-dark-muted">created {formatDate(activeKey.createdAt, producer.city.timezone)}{activeKey.lastUsedAt ? ` · last used ${formatDate(activeKey.lastUsedAt, producer.city.timezone)}` : " · never used"}</p>}
          </div>
          <div>
            <p className="text-xs text-ink-dark-muted">Bound organization</p>
            {producer.eventosOrgId ? (
              <>
                <p className="font-medium">{producer.eventosOrgName ?? producer.eventosOrgId}</p>
                <p className="break-all text-xs text-ink-dark-muted">{producer.eventosOrgId}{producer.eventosConnectedAt ? ` · since ${formatDate(producer.eventosConnectedAt, producer.city.timezone)}` : ""}</p>
              </>
            ) : (
              <p className="text-ink-dark-muted">not connected</p>
            )}
          </div>
          <div>
            <p className="text-xs text-ink-dark-muted">Webhook URL</p>
            <p className="break-all text-xs">{producer.eventosWebhookUrl ?? <span className="text-ink-dark-muted">—</span>}</p>
            {producer.eventosAppUrl && <p className="break-all text-xs text-ink-dark-muted">{producer.eventosAppUrl}</p>}
          </div>
        </div>
        {staff.role === "ADMIN" && (
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={generateApiKeyAction}>
              <input type="hidden" name="id" value={producer.id} />
              <button className="btn btn-outline !py-1 text-xs">{activeKey ? "Generate new key" : "Generate API key"}</button>
            </form>
            {activeKey && (
              <form action={revokeApiKeyAction}>
                <input type="hidden" name="id" value={producer.id} />
                <button className="btn btn-outline !py-1 text-xs text-red">Revoke key</button>
              </form>
            )}
            {producer.eventosOrgId && (
              <form action={unbindEventOSAction}>
                <input type="hidden" name="id" value={producer.id} />
                <button className="btn btn-outline !py-1 text-xs text-red">Disconnect EventOS</button>
              </form>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-dark-muted">Events pushed from EventOS are read-only here (the producer manages them in their SIAPP tab); their discounted tickets are paid to the producer, nothing to settle. See docs/EVENTOS_INTEGRATION.md.</p>
      </div>

      <div className="mt-8">
        <SectionTitle>Settlements · {formatMoney(openCents)} open</SectionTitle>
        <Table>
          <thead>
            <tr>
              <Th>Event</Th>
              <Th align="right">Owed</Th>
              <Th>Status</Th>
              <Th>Statement</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {settlements.length === 0 && <EmptyRow colSpan={5}>Nothing settled yet — settlements appear once an event finishes.</EmptyRow>}
            {settlements.map((s) => (
              <SettlementRow key={s.id} s={s} isAdmin={staff.role === "ADMIN"} back={`/admin/producers/${producer.id}`} showProducer={false} />
            ))}
          </tbody>
        </Table>
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
                <Td><Badge tone={statusTone(e.status)}>{e.status.toLowerCase()}</Badge>{e.source === "EVENTOS" && <> <Badge>EventOS</Badge></>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
