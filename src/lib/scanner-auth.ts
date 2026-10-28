import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SCANNER_COOKIE, verifyScannerToken, type ScannerSession } from "@/domain/scanner";

/** The door's session, from the httpOnly cookie set by the /scan login. */
export async function getScannerSession(): Promise<ScannerSession | null> {
  const jar = await cookies();
  return verifyScannerToken(jar.get(SCANNER_COOKIE)?.value);
}

export class ScannerAuthError extends Error {
  constructor() {
    super("Scanner session expired — sign in again");
    this.name = "ScannerAuthError";
  }
}

export async function requireScannerSession(): Promise<ScannerSession> {
  const session = await getScannerSession();
  if (!session) throw new ScannerAuthError();
  return session;
}

export async function setScannerCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SCANNER_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
}

export async function clearScannerCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SCANNER_COOKIE);
}

/** Shared error → JSON mapping for the /api/scan routes. */
export function scannerApiError(e: unknown): NextResponse {
  if (e instanceof ScannerAuthError) return NextResponse.json({ error: e.message }, { status: 401 });
  if (e && typeof e === "object" && (e as { name?: string }).name === "ScannerError") return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  if (e && typeof e === "object" && (e as { name?: string }).name === "ZodError") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  console.error("scanner api:", e);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
