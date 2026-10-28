import { NextResponse } from "next/server";
import { z } from "zod";
import { processScan } from "@/domain/scanner";
import { requireScannerSession, scannerApiError } from "@/lib/scanner-auth";

const Body = z.object({
  code: z.string().trim().min(1).max(200),
  admitAfterWindow: z.boolean().optional(),
  at: z.string().datetime().optional(),
});

/** One scan from the door. The session cookie names the event and device. */
export async function POST(req: Request) {
  try {
    const session = await requireScannerSession();
    const body = Body.parse(await req.json());
    const outcome = await processScan({ eventId: session.eventId, code: body.code, scannedBy: session.device, admitAfterWindow: body.admitAfterWindow, at: body.at ? new Date(body.at) : undefined });
    return NextResponse.json(outcome);
  } catch (e) {
    return scannerApiError(e);
  }
}
