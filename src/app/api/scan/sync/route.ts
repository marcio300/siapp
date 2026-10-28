import { NextResponse } from "next/server";
import { z } from "zod";
import { syncScans } from "@/domain/scanner";
import { requireScannerSession, scannerApiError } from "@/lib/scanner-auth";

const Body = z.object({
  scans: z
    .array(z.object({ code: z.string().trim().min(1).max(200), at: z.string().datetime(), admitAfterWindow: z.boolean().optional(), disputeNote: z.string().max(500).optional() }))
    .max(500),
});

/** Replay scans queued while the device was offline. */
export async function POST(req: Request) {
  try {
    const session = await requireScannerSession();
    const body = Body.parse(await req.json());
    const results = await syncScans(session.eventId, body.scans, { scannedBy: session.device });
    return NextResponse.json({ results });
  } catch (e) {
    return scannerApiError(e);
  }
}
