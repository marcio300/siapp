import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getMediaStorage } from "@/lib/media/storage";
import { getSetting } from "@/lib/settings";
import { webhookSecrets } from "./connect";

/**
 * Signed selfie URLs for the producer's EventOS scanner (contract §1.3):
 * `GET /api/partner/v1/tickets/{ticketId}/photo?exp&sig`,
 * sig = HMAC_SHA256(webhookSecret, "{ticketId}.{exp}"). No bearer, `no-store`.
 */
export function photoSignature(secret: string, ticketId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${ticketId}.${exp}`).digest("hex");
}

export function verifyPhotoSignature(secrets: string[], ticketId: string, exp: number, sig: string, now = new Date()): "ok" | "expired" | "bad" {
  if (!Number.isFinite(exp)) return "bad";
  const given = Buffer.from(sig, "hex");
  const valid = secrets.some((s) => {
    const expected = Buffer.from(photoSignature(s, ticketId, exp), "hex");
    return expected.length === given.length && given.length > 0 && timingSafeEqual(expected, given);
  });
  if (!valid) return "bad";
  if (exp * 1000 <= now.getTime()) return "expired";
  return "ok";
}

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Build the URL EventOS stores on the mirror ticket; `exp` = event end + partner_photo_ttl_hours. */
export async function signedPhotoUrl(
  producer: Parameters<typeof webhookSecrets>[0],
  ticketId: string,
  eventEndsAt: Date,
  opts: { db?: PrismaClient; now?: Date } = {},
): Promise<{ url: string; expiresAt: Date } | null> {
  const [secret] = webhookSecrets(producer, opts.now);
  if (!secret) return null;
  const ttl = await getSetting("partner_photo_ttl_hours", opts.db ?? defaultPrisma);
  const exp = Math.floor((eventEndsAt.getTime() + ttl * 3_600_000) / 1000);
  return { url: `${appUrl()}/api/partner/v1/tickets/${ticketId}/photo?exp=${exp}&sig=${photoSignature(secret, ticketId, exp)}`, expiresAt: new Date(exp * 1000) };
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic" };

/** Ticket → producer (for the secret) + the selfie bytes. */
export async function loadTicketPhoto(ticketId: string, db: PrismaClient = defaultPrisma) {
  const ticket = await db.ticket.findUnique({ where: { id: ticketId }, include: { redemption: { include: { event: { include: { producer: true } } } } } });
  if (!ticket) return null;
  const url = ticket.photoSnapshotUrl;
  if (!url) return { ticket, producer: ticket.redemption.event.producer, photo: null };
  const data = await getMediaStorage().get(url);
  const ext = url.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  return { ticket, producer: ticket.redemption.event.producer, photo: { data, mime: MIME[ext] ?? "image/jpeg" } };
}
