import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatMoney } from "@/lib/format";
import { PageHeader } from "@/components/backoffice/page-header";
import { StatCard } from "@/components/backoffice/stat-card";
import { EmptyRow, Table, Th } from "@/components/backoffice/table";
import { runSettlementsAction } from "./actions";
import { SettlementRow } from "./settlement-row";

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaffPage("OPS");
  const sp = await searchParams;
  const status = sp.status === "OPEN" || sp.status === "PAID" ? sp.status : undefined;
  const producerId = sp.producer || undefined;
  const [rows, producers, openAgg, openByProducer] = await Promise.all([
    prisma.settlement.findMany({
      where: { ...(status ? { status } : {}), ...(producerId ? { producerId } : {}) },
      include: { producer: { select: { id: true, name: true, contactEmail: true } }, event: { select: { id: true, title: true, startsAt: true, city: { select: { timezone: true } } } }, _count: { select: { lines: true } } },
      orderBy: [{ status: "desc" }, { createdAt: "desc" }],
      take: 300,
    }),
    prisma.producer.findMany({ where: { settlements: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.settlement.aggregate({ where: { status: "OPEN" }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.settlement.groupBy({ by: ["producerId"], where: { status: "OPEN" }, _sum: { amountCents: true } }),
  ]);
  const back = `/admin/settlements${status || producerId ? `?${new URLSearchParams({ ...(status ? { status } : {}), ...(producerId ? { producer: producerId } : {}) })}` : ""}`;
  const names = new Map(producers.map((p) => [p.id, p.name]));
  const topOpen = [...openByProducer].sort((a, b) => (b._sum.amountCents ?? 0) - (a._sum.amountCents ?? 0)).slice(0, 3);

  return (
    <>
      <PageHeader
        title="Settlements"
        subtitle="What we owe producers for scanned discounted tickets: face value minus the discount, per ticket the door actually scanned. The hourly job settles finished events and emails the statement; ADMIN marks them paid."
        actions={
          <form action={runSettlementsAction}>
            <input type="hidden" name="back" value={back} />
            <button className="btn btn-outline">Settle finished events now</button>
          </form>
        }
      />
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {(sp.paid || sp.reopened || sp.sent || sp.ran) && !sp.error && (
        <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">{sp.paid ? "Marked paid." : sp.reopened ? "Reopened." : sp.sent ? "Statement sent." : `Run: ${sp.ran}.`}</p>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Open settlements" value={formatMoney(openAgg._sum.amountCents ?? 0)} hint={`${openAgg._count._all} ${openAgg._count._all === 1 ? "event" : "events"} to pay`} />
        <StatCard label="Largest open" value={topOpen[0] ? formatMoney(topOpen[0]._sum.amountCents ?? 0) : "—"} hint={topOpen[0] ? names.get(topOpen[0].producerId) : "nothing open"} />
        <StatCard label="Producers owed" value={openByProducer.length} hint={topOpen.map((t) => names.get(t.producerId)).filter(Boolean).join(" · ") || "—"} />
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <select name="producer" defaultValue={producerId ?? ""} className="input w-56">
          <option value="">All producers</option>
          {producers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ""} className="input w-36">
          <option value="">Open + paid</option>
          <option value="OPEN">Open</option>
          <option value="PAID">Paid</option>
        </select>
        <button className="btn btn-outline">Filter</button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>Producer</Th>
            <Th>Event</Th>
            <Th align="right">Owed</Th>
            <Th>Status</Th>
            <Th>Statement</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={6}>No settlements yet — they appear once events finish.</EmptyRow>}
          {rows.map((s) => (
            <SettlementRow key={s.id} s={s} isAdmin={staff.role === "ADMIN"} back={back} />
          ))}
        </tbody>
      </Table>
    </>
  );
}
