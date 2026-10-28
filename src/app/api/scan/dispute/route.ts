import { NextResponse } from "next/server";
import { z } from "zod";
import { flagDispute } from "@/domain/scanner";
import { requireScannerSession, scannerApiError } from "@/lib/scanner-auth";

const Body = z.object({ scanId: z.string().min(1), note: z.string().trim().min(1, "Say what the dispute is about").max(500) });

export async function POST(req: Request) {
  try {
    const session = await requireScannerSession();
    const body = Body.parse(await req.json());
    const scan = await flagDispute({ eventId: session.eventId, scanId: body.scanId, note: body.note });
    return NextResponse.json({ ok: true, scanId: scan.id });
  } catch (e) {
    return scannerApiError(e);
  }
}
