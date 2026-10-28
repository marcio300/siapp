import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { describePromo, parsePromo } from "@/domain/partners";
import { formatDate } from "@/lib/format";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { updatePartnerAction } from "../actions";
import { PartnerForm } from "../partner-form";

export default async function PartnerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const staff = await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const community = await prisma.partnerCommunity.findUnique({ where: { id }, include: { claims: { include: { member: { select: { id: true, name: true, email: true } } }, orderBy: { claimedAt: "desc" }, take: 200 } } });
  if (!community) notFound();
  let promo = "invalid promo";
  try {
    promo = describePromo(parsePromo(community.promo));
  } catch {
    /* shown as invalid */
  }

  return (
    <>
      <PageHeader title={community.name} subtitle={`${community.code} · ${promo} · ${community.claims.length} claims`} actions={<Link href="/admin/partners" className="btn btn-ghost">← Partners</Link>} />
      {sp.saved && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Saved.</p>}
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      <div className="card mb-8 p-5">
        <PartnerForm community={community} action={updatePartnerAction} submitLabel="Save" readOnly={staff.role !== "ADMIN"} />
        {staff.role !== "ADMIN" && <p className="mt-3 text-xs text-ink-dark-muted">Only ADMIN staff can edit partner keys and promos.</p>}
      </div>
      <SectionTitle>Claims · {community.claims.length}</SectionTitle>
      <Table>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>Partner member id</Th>
            <Th>Token id</Th>
            <Th>Claimed</Th>
          </tr>
        </thead>
        <tbody>
          {community.claims.length === 0 && <EmptyRow colSpan={4}>Nobody has claimed yet.</EmptyRow>}
          {community.claims.map((c) => (
            <tr key={c.id}>
              <Td><Link href={`/admin/members/${c.member.id}`} className="hover:text-red">{c.member.name ?? c.member.email}</Link></Td>
              <Td className="font-mono text-xs">{c.externalMemberId}</Td>
              <Td className="font-mono text-xs text-ink-dark-muted">{c.tokenJti ?? "—"}</Td>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(c.claimedAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
