import type { FounderLead, FounderLeadStatus, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { toCsv } from "@/lib/csv";

export const LEAD_STATUSES: FounderLeadStatus[] = ["NEW", "CONTACTED", "CONVERTED", "UNSUBSCRIBED"];

/** Staff marks leads as contacted (the launch invitation went out by hand / another tool). */
export async function markLeadsContacted(ids: string[], staffId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<number> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  if (ids.length === 0) return 0;
  const res = await db.founderLead.updateMany({
    where: { id: { in: ids }, status: "NEW" },
    data: { status: "CONTACTED", contactedAt: now, contactedById: staffId },
  });
  return res.count;
}

/** Undo a "contacted" mark (the email bounced, say). Converted/unsubscribed rows are left alone. */
export async function reopenLead(id: string, opts: { db?: PrismaClient } = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const res = await db.founderLead.updateMany({ where: { id, status: "CONTACTED" }, data: { status: "NEW", contactedAt: null, contactedById: null } });
  return res.count > 0;
}

export interface LeadStats {
  total: number;
  byStatus: Record<FounderLeadStatus, number>;
  last7Days: number;
  bySource: { source: string; count: number }[];
}

export async function leadStats(opts: { db?: PrismaClient; now?: Date } = {}): Promise<LeadStats> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const [byStatus, last7Days, bySource] = await Promise.all([
    db.founderLead.groupBy({ by: ["status"], _count: { _all: true } }),
    db.founderLead.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    db.founderLead.groupBy({ by: ["utmSource"], _count: { _all: true }, orderBy: { _count: { utmSource: "desc" } }, take: 8 }),
  ]);
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<FounderLeadStatus, number>;
  for (const row of byStatus) counts[row.status] = row._count._all;
  return {
    total: byStatus.reduce((n, r) => n + r._count._all, 0),
    byStatus: counts,
    last7Days,
    bySource: bySource.map((r) => ({ source: r.utmSource ?? "(direct)", count: r._count._all })),
  };
}

export type LeadCsvRow = FounderLead & { city: { name: string } | null };

/** Export for the CRM / ad platform (custom audiences). Member-supplied cells are formula-escaped by toCsv. */
export function leadsCsv(rows: LeadCsvRow[]): string {
  return toCsv(
    ["number", "email", "name", "city", "language", "status", "signed_up_at", "consent_at", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "referrer", "contacted_at", "converted_at", "unsubscribed_at"],
    rows.map((r) => [
      r.number,
      r.email,
      r.name,
      r.city?.name ?? null,
      r.locale,
      r.status,
      r.createdAt.toISOString(),
      r.consentAt.toISOString(),
      r.utmSource,
      r.utmMedium,
      r.utmCampaign,
      r.utmContent,
      r.utmTerm,
      r.referrer,
      r.contactedAt?.toISOString() ?? null,
      r.convertedAt?.toISOString() ?? null,
      r.unsubscribedAt?.toISOString() ?? null,
    ]),
  );
}
