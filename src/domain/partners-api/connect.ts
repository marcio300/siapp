import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "@/lib/db";
import { decryptText, encryptText } from "@/lib/media/crypto";
import { getSetting } from "@/lib/settings";
import { PartnerApiError, validationFailed } from "./errors";
import { CONTRACT_VERSION, loadLimits, loadPricing } from "./pricing";

/**
 * `POST /connect` (contract §3.1): bind the producer to an EventOS org,
 * rotate the webhook secret (SIAPP signs with it, so it is stored encrypted at
 * rest — see docs/EVENTOS_INTEGRATION.md), return profile + pricing + limits.
 */
export const ConnectSchema = z.object({
  eventosOrgId: z.string().trim().min(1).max(100),
  eventosOrgName: z.string().trim().max(200).optional(),
  webhookUrl: z.string().url().max(500),
  appUrl: z.string().url().max(500).optional(),
});

const PREVIOUS_SECRET_HOURS = 24;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

type Producer = Prisma.ProducerGetPayload<{ include: { city: true } }>;

export async function connectProducer(producer: Producer, raw: unknown, opts: { db?: PrismaClient; now?: Date } = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = ConnectSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join("."), code: "invalid", message: i.message })));
  const input = parsed.data;
  if (producer.eventosOrgId && producer.eventosOrgId !== input.eventosOrgId) {
    throw new PartnerApiError(409, "producer_bound", "This producer is already connected to a different EventOS organization — SIAPP staff must unbind it first");
  }
  const secret = generateWebhookSecret();
  const updated = await db.producer.update({
    where: { id: producer.id },
    data: {
      eventosOrgId: input.eventosOrgId,
      eventosOrgName: input.eventosOrgName ?? null,
      eventosWebhookUrl: input.webhookUrl,
      eventosAppUrl: input.appUrl ?? null,
      eventosWebhookSecretEnc: encryptText(secret),
      eventosPreviousSecretEnc: producer.eventosWebhookSecretEnc,
      eventosPreviousSecretUntil: producer.eventosWebhookSecretEnc ? new Date(now.getTime() + PREVIOUS_SECRET_HOURS * 3_600_000) : null,
      eventosConnectedAt: producer.eventosConnectedAt ?? now,
      usesEventOS: true,
    },
    include: { city: true },
  });
  const [pricing, limits, photoTtl] = await Promise.all([loadPricing(db), loadLimits(db), getSetting("partner_photo_ttl_hours", db)]);
  return {
    contract: CONTRACT_VERSION,
    producer: {
      id: updated.id,
      name: updated.name,
      city: { id: updated.city.id, name: updated.city.name, country: updated.city.country, timezone: updated.city.timezone, currency: updated.city.currency },
    },
    pricing,
    limits,
    webhookSecret: secret,
    scannerPhotoTtlHours: photoTtl,
  };
}

/** Current + still-valid previous webhook secrets (decrypted) — for signing and verifying. */
export function webhookSecrets(producer: { eventosWebhookSecretEnc: string | null; eventosPreviousSecretEnc: string | null; eventosPreviousSecretUntil: Date | null }, now = new Date()): string[] {
  const out: string[] = [];
  if (producer.eventosWebhookSecretEnc) out.push(decryptText(producer.eventosWebhookSecretEnc));
  if (producer.eventosPreviousSecretEnc && producer.eventosPreviousSecretUntil && producer.eventosPreviousSecretUntil > now) out.push(decryptText(producer.eventosPreviousSecretEnc));
  return out;
}

/** Staff: disconnect (clears the binding; keys are revoked separately). */
export async function unbindProducer(producerId: string, db: PrismaClient = defaultPrisma) {
  return db.producer.update({
    where: { id: producerId },
    data: { eventosOrgId: null, eventosOrgName: null, eventosWebhookUrl: null, eventosAppUrl: null, eventosWebhookSecretEnc: null, eventosPreviousSecretEnc: null, eventosPreviousSecretUntil: null, eventosConnectedAt: null },
  });
}
