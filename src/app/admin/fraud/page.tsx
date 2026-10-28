import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { banMemberAction, reviewFlagAction } from "./actions";

const RULE_LABEL: Record<string, string> = {
  DEVICE_MAX_ACCOUNTS: "Shared device",
  VELOCITY_FIRST_HOUR: "Velocity (first hour)",
  VELOCITY_PRIVATE_SALE: "Velocity (private sale)",
  OVERLAP: "Overlapping events",
  SAME_CARD: "Shared card",
  SELF_REFERRAL: "Self-referral",
};

/** Fraud queue (spec §10): OPEN flags with evidence; approve / deny / ban. */
export default async function FraudQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaffPage("OPS");
  const sp = await searchParams;
  const showClosed = sp.closed === "1";
  const flags = await prisma.fraudFlag.findMany({
    where: showClosed ? { status: { not: "OPEN" } } : { status: "OPEN" },
    include: { member: { select: { id: true, email: true, name: true, bannedAt: true, city: { select: { timezone: true } } } }, redemption: { select: { id: true, status: true, event: { select: { title: true } } } }, reviewedBy: { select: { name: true, email: true } } },
    orderBy: showClosed ? { reviewedAt: "desc" } : { createdAt: "asc" },
    take: 200,
  });
  const openCount = showClosed ? await prisma.fraudFlag.count({ where: { status: "OPEN" } }) : flags.length;

  return (
    <>
      <PageHeader
        title="Fraud queue"
        subtitle={`${openCount} open ${openCount === 1 ? "flag" : "flags"}. Approving a flag tied to a held redemption releases it once every flag on it is approved; denying denies the redemption.`}
        actions={
          <Link href={showClosed ? "/admin/fraud" : "/admin/fraud?closed=1"} className="btn btn-outline">
            {showClosed ? "Show open" : "Show reviewed"}
          </Link>
        }
      />
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {sp.reviewed && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Flag {sp.reviewed}.</p>}
      {sp.banned && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Member banned.</p>}

      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Member</Th>
            <Th>Rule</Th>
            <Th>Evidence</Th>
            <Th>Redemption</Th>
            <Th>{showClosed ? "Outcome" : "Decision"}</Th>
          </tr>
        </thead>
        <tbody>
          {flags.length === 0 && <EmptyRow colSpan={6}>{showClosed ? "Nothing reviewed yet." : "Queue is empty. Nice."}</EmptyRow>}
          {flags.map((f) => (
            <tr key={f.id}>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(f.createdAt, f.member.city?.timezone)}</Td>
              <Td>
                <Link href={`/admin/members/${f.member.id}`} className="font-medium hover:text-red">{f.member.name ?? f.member.email}</Link>
                {f.member.name && <div className="text-xs text-ink-dark-muted">{f.member.email}</div>}
                {f.member.bannedAt && <Badge tone="red">banned</Badge>}
              </Td>
              <Td><Badge tone="warn">{RULE_LABEL[f.rule] ?? f.rule}</Badge></Td>
              <Td>
                <pre className="max-w-xs whitespace-pre-wrap break-all font-mono text-[11px] text-ink-dark-muted">{JSON.stringify(f.evidence, null, 1)}</pre>
              </Td>
              <Td className="text-ink-dark-muted">
                {f.redemption ? (
                  <>
                    {f.redemption.event.title}
                    <div><Badge>{f.redemption.status.toLowerCase().replace("_", " ")}</Badge></div>
                  </>
                ) : "—"}
              </Td>
              <Td>
                {f.status === "OPEN" ? (
                  <div className="flex flex-col gap-2">
                    <form action={reviewFlagAction} className="flex flex-wrap items-center gap-1">
                      <input type="hidden" name="flagId" value={f.id} />
                      <input name="note" placeholder="note" className="input w-32 !py-1 text-xs" />
                      <button name="decision" value="APPROVED" className="btn btn-outline !py-1 text-xs">Approve</button>
                      <button name="decision" value="DENIED" className="btn btn-outline !py-1 text-xs text-red">Deny</button>
                    </form>
                    {staff.role === "ADMIN" && !f.member.bannedAt && (
                      <form action={banMemberAction} className="flex items-center gap-1">
                        <input type="hidden" name="memberId" value={f.member.id} />
                        <input type="hidden" name="back" value="/admin/fraud" />
                        <input name="reason" required minLength={3} placeholder="ban reason" className="input w-32 !py-1 text-xs" />
                        <button className="btn btn-primary !py-1 text-xs">Ban</button>
                      </form>
                    )}
                  </div>
                ) : (
                  <div className="text-xs">
                    <Badge tone={f.status === "APPROVED" ? "ok" : "red"}>{f.status.toLowerCase()}</Badge>
                    <div className="mt-1 text-ink-dark-muted">
                      {f.reviewedBy?.name ?? f.reviewedBy?.email}
                      {f.reviewNote ? ` · ${f.reviewNote}` : ""}
                    </div>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
