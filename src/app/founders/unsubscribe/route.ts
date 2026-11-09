import { NextResponse } from "next/server";
import { LeadError, unsubscribeLead } from "@/domain/leads";

export const dynamic = "force-dynamic";

/** One-click unsubscribe link from the welcome email: `?t=<unsubscribeToken>`. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t")?.trim() ?? "";
  try {
    if (!token) throw new LeadError("not_found");
    await unsubscribeLead(token);
    return NextResponse.redirect(new URL("/founders?unsubscribed=1", req.url));
  } catch (e) {
    if (e instanceof LeadError) return NextResponse.redirect(new URL("/founders?error=not_found", req.url));
    throw e;
  }
}
