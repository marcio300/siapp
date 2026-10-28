import { NextResponse } from "next/server";
import { searchTickets } from "@/domain/scanner";
import { requireScannerSession, scannerApiError } from "@/lib/scanner-auth";

export const dynamic = "force-dynamic";

/** Manual lookup by name or email when a QR won't read. */
export async function GET(req: Request) {
  try {
    const session = await requireScannerSession();
    const q = new URL(req.url).searchParams.get("q") ?? "";
    return NextResponse.json({ hits: await searchTickets(session.eventId, q) });
  } catch (e) {
    return scannerApiError(e);
  }
}
