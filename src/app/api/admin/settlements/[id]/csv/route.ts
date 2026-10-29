import { NextResponse } from "next/server";
import { AuthzError, requireStaff } from "@/lib/authz";
import { csvResponse } from "@/lib/csv";
import { SettlementError, settlementStatement, statementCsv, statementFilename } from "@/domain/settlement";

export const dynamic = "force-dynamic";

/** The ticket-by-ticket statement as CSV (same file the producer gets by email). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireStaff("OPS");
    const { id } = await ctx.params;
    const { settlement, rows } = await settlementStatement(id);
    const csv = statementCsv({ event: settlement.event, timezone: settlement.event.city.timezone, rows, amountCents: settlement.amountCents, currency: settlement.currency });
    return csvResponse(csv, statementFilename(settlement.event));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof SettlementError) return NextResponse.json({ error: e.message }, { status: 404 });
    console.error(e);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
