import { NextResponse } from "next/server";
import { scannerSummary, ticketManifest } from "@/domain/scanner";
import { requireScannerSession, scannerApiError } from "@/lib/scanner-auth";

export const dynamic = "force-dynamic";

/** Counters + the offline manifest; polled by the scanner while online. */
export async function GET(req: Request) {
  try {
    const session = await requireScannerSession();
    const withManifest = new URL(req.url).searchParams.get("manifest") !== "0";
    const [summary, manifest] = await Promise.all([scannerSummary(session.eventId), withManifest ? ticketManifest(session.eventId) : Promise.resolve(undefined)]);
    if (!summary || manifest === null) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    return NextResponse.json({ summary, manifest, device: session.device }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return scannerApiError(e);
  }
}
