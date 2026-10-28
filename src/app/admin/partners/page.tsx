import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { describePromo, parsePromo } from "@/domain/partners";
import { formatDateOnly } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { createPartnerAction } from "./actions";
import { PartnerForm } from "./partner-form";

function promoLabel(json: unknown): string {
  try {
    return describePromo(parsePromo(json));
  } catch {
    return "invalid promo";
  }
}

export default async function PartnersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const staff = await requireStaffPage("OPS");
  const { error } = await searchParams;
  const communities = await prisma.partnerCommunity.findMany({ include: { _count: { select: { claims: true } } }, orderBy: { name: "asc" } });

  return (
    <>
      <PageHeader title="Partner communities" subtitle="ELL and friends. They sign a claim token with their private key; we verify with the public key here and apply the promo once per member. Contract: docs/PARTNER_TOKEN.md." />
      {error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{error}</p>}
      <Table className="mb-8">
        <thead>
          <tr>
            <Th>Community</Th>
            <Th>Code</Th>
            <Th>Promo</Th>
            <Th align="right">Claims</Th>
            <Th>Status</Th>
            <Th>Since</Th>
          </tr>
        </thead>
        <tbody>
          {communities.length === 0 && <EmptyRow colSpan={6}>No partner communities yet.</EmptyRow>}
          {communities.map((c) => (
            <tr key={c.id}>
              <Td><Link href={`/admin/partners/${c.id}`} className="font-medium hover:text-red">{c.name}</Link></Td>
              <Td className="font-mono text-xs">{c.code}</Td>
              <Td className="text-ink-dark-muted">{promoLabel(c.promo)}</Td>
              <Td align="right">{c._count.claims}</Td>
              <Td>{c.isActive ? <Badge tone="ok">accepting claims</Badge> : <Badge tone="warn">paused</Badge>}</Td>
              <Td className="text-ink-dark-muted">{formatDateOnly(c.createdAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {staff.role === "ADMIN" && (
        <>
          <SectionTitle>New partner community</SectionTitle>
          <div className="card p-5">
            <PartnerForm action={createPartnerAction} submitLabel="Create partner" />
          </div>
        </>
      )}
    </>
  );
}
