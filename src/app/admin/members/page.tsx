import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatDateOnly } from "@/lib/format";
import { PageHeader } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { KeyIcon } from "@/components/key-icon";

const CAP = 100;

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireStaffPage("OPS");
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const where = query
    ? { OR: [{ email: { contains: query, mode: "insensitive" as const } }, { name: { contains: query, mode: "insensitive" as const } }, { referralCode: { equals: query.toUpperCase() } }] }
    : {};
  const [members, total] = await Promise.all([
    prisma.member.findMany({ where, include: { city: true, keyBalance: true }, orderBy: { createdAt: "desc" }, take: CAP }),
    prisma.member.count({ where }),
  ]);

  return (
    <>
      <PageHeader
        title="Members"
        subtitle={`${total} ${total === 1 ? "member" : "members"}${total > CAP ? ` — showing the latest ${CAP}, narrow the search` : ""}`}
        actions={
          <form className="flex gap-2">
            <input name="q" defaultValue={query} placeholder="Search email, name or referral code" className="input w-72" />
            <button className="btn btn-outline">Search</button>
          </form>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>City</Th>
            <Th align="right">Plan keys</Th>
            <Th align="right">Purchased</Th>
            <Th>Joined</Th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 && <EmptyRow colSpan={5}>No members match.</EmptyRow>}
          {members.map((m) => {
            const expired = !m.keyBalance?.planKeysExpireAt || m.keyBalance.planKeysExpireAt <= new Date();
            return (
              <tr key={m.id}>
                <Td>
                  <Link href={`/admin/members/${m.id}`} className="font-medium hover:text-red">
                    {m.name ?? m.email}
                  </Link>
                  {m.name && <div className="text-xs text-ink-dark-muted">{m.email}</div>}
                </Td>
                <Td>{m.city?.name ?? <span className="text-ink-dark-muted">—</span>}</Td>
                <Td align="right">
                  <span className="inline-flex items-center gap-1"><KeyIcon className="h-3.5 w-3.5 text-red" /> {expired ? 0 : (m.keyBalance?.planKeys ?? 0)}</span>
                </Td>
                <Td align="right">
                  <span className="inline-flex items-center gap-1"><KeyIcon className="h-3.5 w-3.5 text-red" /> {m.keyBalance?.purchasedKeys ?? 0}</span>
                </Td>
                <Td className="text-ink-dark-muted">{formatDateOnly(m.createdAt, m.city?.timezone)}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
