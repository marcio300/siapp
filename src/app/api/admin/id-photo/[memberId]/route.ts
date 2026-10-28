import { NextResponse } from "next/server";
import { AuthzError, requireStaff } from "@/lib/authz";
import { readIdPhoto } from "@/domain/identity";

/** Staff-only: decrypt and stream a tourist's ID photo for review. Never cached. */
export async function GET(_req: Request, ctx: { params: Promise<{ memberId: string }> }) {
  try {
    await requireStaff("OPS");
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    throw e;
  }
  const { memberId } = await ctx.params;
  const photo = await readIdPhoto(memberId);
  if (!photo) return NextResponse.json({ error: "No ID photo" }, { status: 404 });
  return new NextResponse(new Uint8Array(photo.data), {
    headers: { "content-type": photo.mime, "cache-control": "no-store, private", "x-content-type-options": "nosniff" },
  });
}
