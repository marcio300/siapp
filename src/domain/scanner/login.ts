import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { verifyPin } from "@/domain/events";
import { ScannerError } from "./errors";
import { createScannerToken } from "./session";

export const SCANNER_MAX_FAILED_LOGINS = 5;
export const SCANNER_LOCK_MINUTES = 15;
/** The session outlives the event by this much so late scans and the door's wrap-up still work. */
export const SCANNER_SESSION_GRACE_MS = 12 * 3_600_000;
const SCANNER_SESSION_MIN_MS = 2 * 3_600_000;

interface Opts {
  db?: PrismaClient;
  now?: Date;
}

/**
 * Door login: event scanner code + PIN. Rate-limited per event: after
 * SCANNER_MAX_FAILED_LOGINS wrong PINs the code locks for SCANNER_LOCK_MINUTES
 * (a 6-digit PIN would otherwise be brute-forceable from any phone). Wrong
 * code and wrong PIN get the same message. Returns the signed session token.
 */
export async function loginScanner(input: { code: string; pin: string; device?: string }, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const code = input.code.trim().toUpperCase();
  const pin = input.pin.trim();
  const device = (input.device ?? "").trim().slice(0, 40) || "Door";
  const generic = new ScannerError("Wrong scanner code or PIN");
  if (!code || !pin) throw generic;

  const event = await db.event.findUnique({ where: { scannerCode: code } });
  if (!event) throw generic;
  if (event.scannerLockedUntil && event.scannerLockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((event.scannerLockedUntil.getTime() - now.getTime()) / 60_000));
    throw new ScannerError(`Too many wrong PINs — this code is locked for ${minutes} more minute${minutes === 1 ? "" : "s"}`);
  }
  if (event.status === "CANCELLED") throw new ScannerError("This event was cancelled");

  if (!verifyPin(pin, event.scannerPinHash)) {
    const failed = (event.scannerLockedUntil ? 0 : event.scannerFailedLogins) + 1;
    const lock = failed >= SCANNER_MAX_FAILED_LOGINS;
    await db.event.update({
      where: { id: event.id },
      data: { scannerFailedLogins: lock ? 0 : failed, scannerLockedUntil: lock ? new Date(now.getTime() + SCANNER_LOCK_MINUTES * 60_000) : null },
    });
    throw lock ? new ScannerError(`Too many wrong PINs — this code is locked for ${SCANNER_LOCK_MINUTES} minutes`) : generic;
  }

  if (event.scannerFailedLogins > 0 || event.scannerLockedUntil) {
    await db.event.update({ where: { id: event.id }, data: { scannerFailedLogins: 0, scannerLockedUntil: null } });
  }
  const exp = Math.max(event.endsAt.getTime() + SCANNER_SESSION_GRACE_MS, now.getTime() + SCANNER_SESSION_MIN_MS);
  const token = createScannerToken({ eventId: event.id, device, exp });
  return { event, device, token, expiresAt: new Date(exp) };
}
