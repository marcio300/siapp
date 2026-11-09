import { NextResponse } from "next/server";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale } from "@/i18n/locales";

/** The EN/PT toggle: `GET /api/locale?set=pt&next=/founders` → cookie + redirect back. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const set = url.searchParams.get("set");
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  if (isLocale(set)) {
    res.cookies.set(LOCALE_COOKIE, set, { maxAge: LOCALE_COOKIE_MAX_AGE, path: "/", sameSite: "lax", httpOnly: false });
  }
  return res;
}
