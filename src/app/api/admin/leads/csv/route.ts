import { NextResponse } from "next/server";
import type { FounderLeadStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AuthzError, requireStaff } from "@/lib/authz";
import { csvResponse } from "@/lib/csv";
import { LEAD_STATUSES, leadsCsv } from "@/domain/leads";

export const dynamic = "force-dynamic";

/** Every lead matching the backoffice filters (`status`, `q`, `source`) — for the CRM or an ad platform audience. */
export async function GET(req: Request) {
  try {
    await requireStaff("OPS");
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "";
    const q = url.searchParams.get("q")?.trim() ?? "";
    const source = url.searchParams.get("source")?.trim() ?? "";
    const where: Prisma.FounderLeadWhereInput = {
      ...(LEAD_STATUSES.includes(status as FounderLeadStatus) ? { status: status as FounderLeadStatus } : {}),
      ...(source ? (source === "(direct)" ? { utmSource: null } : { utmSource: source }) : {}),
      ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const rows = await prisma.founderLead.findMany({ where, include: { city: { select: { name: true } } }, orderBy: { number: "asc" } });
    return csvResponse(leadsCsv(rows), `siapp-founders-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: 403 });
    console.error(e);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
