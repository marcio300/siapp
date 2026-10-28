import { NextResponse } from "next/server";

const REFERRAL_COOKIE = "siapp_ref"; // read by /app/onboarding

/** Referral link: remember the code for 30 days, then send to sign-in. Onboarding reads it. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  const res = NextResponse.redirect(new URL("/sign-in?next=%2Fapp", req.url));
  if (clean) {
    res.cookies.set(REFERRAL_COOKIE, clean, { maxAge: 30 * 86_400, path: "/", sameSite: "lax", httpOnly: true });
  }
  return res;
}
