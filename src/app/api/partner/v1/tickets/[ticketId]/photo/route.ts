import { NextResponse } from "next/server";
import { loadTicketPhoto, verifyPhotoSignature, webhookSecrets } from "@/domain/partners-api";

type Ctx = { params: Promise<{ ticketId: string }> };

const NO_STORE = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };

/** Contract §1.3 — query-signed selfie for the producer's scanner. No bearer. */
export async function GET(req: Request, { params }: Ctx) {
  const { ticketId } = await params;
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const loaded = await loadTicketPhoto(ticketId);
  if (!loaded) return NextResponse.json({ error: { code: "not_found", message: "Unknown ticket" } }, { status: 404, headers: NO_STORE });
  const verdict = verifyPhotoSignature(webhookSecrets(loaded.producer), ticketId, exp, sig);
  if (verdict === "bad") return NextResponse.json({ error: { code: "bad_signature", message: "Bad signature" } }, { status: 403, headers: NO_STORE });
  if (verdict === "expired") return NextResponse.json({ error: { code: "expired", message: "This photo link has expired" } }, { status: 410, headers: NO_STORE });
  if (!loaded.photo) return NextResponse.json({ error: { code: "not_found", message: "No photo on this ticket" } }, { status: 404, headers: NO_STORE });
  return new NextResponse(new Uint8Array(loaded.photo.data), { headers: { "content-type": loaded.photo.mime, ...NO_STORE } });
}
