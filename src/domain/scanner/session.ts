import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Scanner sessions are stateless: an HMAC-signed token (AUTH_SECRET) that
 * names the event and the door device, valid until the event is well over.
 * Producers have no account (CLAUDE.md rule 10), so this is the whole identity
 * of a door login — the token is kept in an httpOnly cookie by the /scan app.
 */
export const SCANNER_COOKIE = "siapp_scan";

export interface ScannerSession {
  eventId: string;
  device: string;
  exp: number; // ms since epoch
}

function secret(): string {
  return process.env.AUTH_SECRET ?? "dev";
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function createScannerToken(session: ScannerSession): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...session })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyScannerToken(token: string | undefined | null, now = new Date()): ScannerSession | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ScannerSession> & { v?: number };
    if (parsed.v !== 1 || typeof parsed.eventId !== "string" || typeof parsed.device !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now.getTime()) return null;
    return { eventId: parsed.eventId, device: parsed.device, exp: parsed.exp };
  } catch {
    return null;
  }
}
