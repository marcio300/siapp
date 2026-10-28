import Link from "next/link";
import type { ReferralStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { formatDateOnly } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader } from "@/components/backoffice/page-header";
import { StatCard } from "@/components/backoffice/stat-card";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { runVestingAction } from "./actions";

const STATUSES: ReferralStatus[] = ["PENDING", "VESTED", "REJECTED"];

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; ran?: string }> }) {
  await requireStaffPage("OPS");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as ReferralStatus) ? (sp.status as ReferralStatus) : undefined;
  const q = sp.q?.trim() ?? "";
  const memberMatch = q ? { OR: [{ email: { contains: q, mode: "insensitive" as const } }, { name: { contains: q, mode: "insensitive" as const } }] } : undefined;
  const [rows, counts, bonus, vestingDays, cap] = await Promise.all([
    prisma.referral.findMany({
      where: { ...(status ? { status } : {}), ...(q ? { OR: [{ code: { contains: q.toUpperCase() } }, { referrer: memberMatch }, { invitee: memberMatch }] } : {}) },
      include: { referrer: { select: { id: true, name: true, email: true } }, invitee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.referral.groupBy({ by: ["status"], _count: { _all: true } }),
    getSetting("referral_bonus_keys"),
    getSetting("referral_vesting_days"),
    getSetting("referral_monthly_cap"),
  ]);
  const count = (s: ReferralStatus) => counts.find((c) => c.status === s)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="Referrals"
        subtitle={`${bonus} keys each, vesting ${vestingDays} days after the invitee's first payment plus one scanned ticket · cap ${cap} per referrer per month. The daily job vests; run it now to check.`}
        actions={
          <form action={runVestingAction}>
            <button className="btn btn-outline">Run vesting now</button>
          </form>
        }
      />
      {sp.ran && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Vesting run: {sp.ran}.</p>}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Pending" value={count("PENDING")} />
        <StatCard label="Vested" value={count("VESTED")} hint={`${count("VESTED") * bonus * 2} keys paid out`} />
        <StatCard label="Rejected" value={count("REJECTED")} hint="flagged in the fraud queue" />
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Email, name or code" className="input w-64" />
        <select name="status" defaultValue={status ?? ""} className="input w-40">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.toLowerCase()}</option>
          ))}
        </select>
        <button className="btn btn-outline">Filter</button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>Referrer</Th>
            <Th>Invitee</Th>
            <Th>Code</Th>
            <Th>Status</Th>
            <Th>Signed up</Th>
            <Th>Vested</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={6}>No referrals match.</EmptyRow>}
          {rows.map((r) => (
            <tr key={r.id}>
              <Td><Link href={`/admin/members/${r.referrer.id}`} className="hover:text-red">{r.referrer.name ?? r.referrer.email}</Link></Td>
              <Td><Link href={`/admin/members/${r.invitee.id}`} className="hover:text-red">{r.invitee.name ?? r.invitee.email}</Link></Td>
              <Td className="font-mono text-xs">{r.code}</Td>
              <Td>
                <Badge tone={r.status === "VESTED" ? "ok" : r.status === "REJECTED" ? "red" : "warn"}>{r.status.toLowerCase()}</Badge>
                {r.rejectedReason && <span className="ml-2 text-xs text-ink-dark-muted">{r.rejectedReason.replace("_", " ")}</span>}
              </Td>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDateOnly(r.createdAt)}</Td>
              <Td className="whitespace-nowrap text-ink-dark-muted">{r.vestedAt ? formatDateOnly(r.vestedAt) : "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
