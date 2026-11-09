import Link from "next/link";
import type { FounderLeadStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatDate } from "@/lib/format";
import { Badge, type BadgeTone } from "@/components/backoffice/badge";
import { PageHeader } from "@/components/backoffice/page-header";
import { StatCard } from "@/components/backoffice/stat-card";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { LEAD_STATUSES, leadStats } from "@/domain/leads";
import { markContactedAction, reopenLeadAction } from "./actions";

const TONE: Record<FounderLeadStatus, BadgeTone> = { NEW: "warn", CONTACTED: "neutral", CONVERTED: "ok", UNSUBSCRIBED: "red" };
const PAGE = 200;

type Search = { status?: string; q?: string; source?: string; contacted?: string; reopened?: string; error?: string };

/** Pre-registrations from /founders: who to invite when the doors open, and where they came from. */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaffPage("OPS");
  const sp = await searchParams;
  const status = LEAD_STATUSES.includes(sp.status as FounderLeadStatus) ? (sp.status as FounderLeadStatus) : undefined;
  const q = sp.q?.trim() ?? "";
  const source = sp.source?.trim() ?? "";
  const where: Prisma.FounderLeadWhereInput = {
    ...(status ? { status } : {}),
    ...(source ? (source === "(direct)" ? { utmSource: null } : { utmSource: source }) : {}),
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])] } : {}),
  };
  const [rows, total, stats] = await Promise.all([
    prisma.founderLead.findMany({ where, include: { city: { select: { name: true } }, member: { select: { id: true } } }, orderBy: { number: "desc" }, take: PAGE }),
    prisma.founderLead.count({ where }),
    leadStats(),
  ]);
  const filterQuery = new URLSearchParams(Object.entries({ status: status ?? "", q, source }).filter(([, v]) => v)).toString();
  const back = `/admin/leads${filterQuery ? `?${filterQuery}` : ""}`;
  const newIds = rows.filter((r) => r.status === "NEW").map((r) => r.id);

  return (
    <>
      <PageHeader
        title="Founders"
        subtitle="Pre-registrations from /founders. They're leads, not members: when the doors open, invite them to create an account with the same email and the row flips to converted by itself."
        actions={
          <>
            <Link href={`/api/admin/leads/csv${filterQuery ? `?${filterQuery}` : ""}`} className="btn btn-outline">Export CSV</Link>
            <a href="/founders" target="_blank" rel="noreferrer" className="btn btn-ghost">Open the page ↗</a>
          </>
        }
      />
      {sp.contacted && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">{sp.contacted} marked as contacted.</p>}
      {sp.reopened && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Lead is back in the to-contact list.</p>}
      {sp.error && <p className="mb-4 rounded-lg border border-red/40 bg-red/10 px-4 py-2 text-sm text-red">Nothing changed — the lead isn&apos;t in the contacted state.</p>}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="On the list" value={stats.total} hint={`${stats.last7Days} in the last 7 days`} />
        <StatCard label="To contact" value={stats.byStatus.NEW} />
        <StatCard label="Contacted" value={stats.byStatus.CONTACTED} hint="invitation sent" />
        <StatCard label="Converted" value={stats.byStatus.CONVERTED} hint="created an account" />
        <StatCard label="Unsubscribed" value={stats.byStatus.UNSUBSCRIBED} />
      </div>

      {stats.bySource.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-xs text-ink-dark-muted">
          <span className="font-semibold uppercase tracking-wide">By source</span>
          {stats.bySource.map((s) => (
            <Link key={s.source} href={`/admin/leads?source=${encodeURIComponent(s.source)}${status ? `&status=${status}` : ""}`} className={`rounded-full border px-2.5 py-1 ${source === s.source ? "border-red bg-red/10 text-red" : "border-line-light bg-white hover:border-ink-dark-muted"}`}>
              {s.source} · {s.count}
            </Link>
          ))}
        </div>
      )}

      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Email, name or founder #" className="input w-64" />
        <select name="status" defaultValue={status ?? ""} className="input w-44">
          <option value="">Any status</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>{s.toLowerCase()}</option>
          ))}
        </select>
        {source && <input type="hidden" name="source" value={source} />}
        <button className="btn btn-outline">Filter</button>
        {(q || status || source) && <Link href="/admin/leads" className="btn btn-ghost">Clear</Link>}
      </form>

      {newIds.length > 0 && (
        <form action={markContactedAction} className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-line-light bg-white px-4 py-2 text-sm">
          <input type="hidden" name="back" value={back} />
          {newIds.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-ink-dark-muted">{newIds.length} of the leads below still need the invitation.</span>
          <button className="btn btn-outline !py-1 text-xs">Mark these {newIds.length} as contacted</button>
        </form>
      )}

      <Table>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Lead</Th>
            <Th>City</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th>Signed up</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={7}>No leads match{total === 0 && !q && !status && !source ? " yet — share /founders" : ""}.</EmptyRow>}
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs text-ink-dark-muted">{r.number}</Td>
              <Td>
                <p className="font-medium">{r.email}</p>
                {r.name && <p className="text-xs text-ink-dark-muted">{r.name}</p>}
              </Td>
              <Td className="text-ink-dark-muted">{r.city?.name ?? "—"}</Td>
              <Td className="text-xs text-ink-dark-muted">
                {r.utmSource ?? "(direct)"}
                {r.utmCampaign && <span className="block">{r.utmCampaign}{r.utmContent ? ` · ${r.utmContent}` : ""}</span>}
              </Td>
              <Td>
                <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                {r.status === "CONVERTED" && r.member && <Link href={`/admin/members/${r.member.id}`} className="ml-2 text-xs hover:text-red">member →</Link>}
                {r.status === "CONTACTED" && r.contactedAt && <span className="ml-2 text-xs text-ink-dark-muted">{formatDate(r.contactedAt)}</span>}
              </Td>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(r.createdAt)}</Td>
              <Td align="right">
                {r.status === "NEW" && (
                  <form action={markContactedAction}>
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="ids" value={r.id} />
                    <button className="btn btn-ghost !py-1 text-xs">Contacted</button>
                  </form>
                )}
                {r.status === "CONTACTED" && (
                  <form action={reopenLeadAction}>
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="id" value={r.id} />
                    <button className="btn btn-ghost !py-1 text-xs">Undo</button>
                  </form>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {total > rows.length && <p className="mt-3 text-xs text-ink-dark-muted">Showing the newest {rows.length} of {total}. Narrow the filter or export the CSV for the full list.</p>}
    </>
  );
}
