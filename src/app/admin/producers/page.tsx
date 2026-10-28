import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { createProducerAction } from "./actions";
import { ProducerForm } from "./producer-form";

export default async function ProducersPage({ searchParams }: { searchParams: Promise<{ error?: string; q?: string }> }) {
  await requireStaffPage("OPS");
  const { error, q } = await searchParams;
  const query = q?.trim() ?? "";
  const [producers, cities] = await Promise.all([
    prisma.producer.findMany({
      where: query ? { name: { contains: query, mode: "insensitive" } } : {},
      include: { city: true, _count: { select: { events: true } } },
      orderBy: { name: "asc" },
      take: 200,
    }),
    prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        title="Producers"
        subtitle="Clubs, promoters, festivals. No login — they get a scanner code per event and a settlement email."
        actions={
          <form className="flex gap-2">
            <input name="q" defaultValue={query} placeholder="Search" className="input w-56" />
            <button className="btn btn-outline">Search</button>
          </form>
        }
      />
      {error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{error}</p>}
      <Table className="mb-8">
        <thead>
          <tr>
            <Th>Producer</Th>
            <Th>City</Th>
            <Th>Contact</Th>
            <Th align="right">Events</Th>
            <Th>Payout</Th>
          </tr>
        </thead>
        <tbody>
          {producers.length === 0 && <EmptyRow colSpan={5}>No producers yet.</EmptyRow>}
          {producers.map((p) => (
            <tr key={p.id}>
              <Td>
                <Link href={`/admin/producers/${p.id}`} className="font-medium hover:text-red">{p.name}</Link>
                {p.usesEventOS && <span className="ml-2"><Badge>EventOS</Badge></span>}
              </Td>
              <Td>{p.city.name}</Td>
              <Td className="text-ink-dark-muted">{p.contactEmail ?? p.contactName ?? "—"}</Td>
              <Td align="right">{p._count.events}</Td>
              <Td>{p.payoutDetailsEncrypted ? <Badge tone="ok">on file</Badge> : <Badge tone="warn">missing</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <SectionTitle>New producer</SectionTitle>
      <div className="card p-5">
        <ProducerForm cities={cities} action={createProducerAction} submitLabel="Create producer" />
      </div>
    </>
  );
}
