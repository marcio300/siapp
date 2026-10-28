import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "@/lib/db";
import { decryptText, encryptText } from "@/lib/media/crypto";

/**
 * Producers (spec §5): clubs, promoters, festivals. No login at launch —
 * staff manage them here; they get a per-event scanner login and a
 * settlement email. Payout details (IBAN etc.) are encrypted at rest.
 */
export class ProducerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProducerError";
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const ProducerSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  cityId: z.string().min(1, "Pick a city"),
  contactName: optionalText(120),
  contactEmail: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid contact email"),
  contactPhone: optionalText(40),
  /** Plain text as entered; stored encrypted. Empty keeps the stored value. */
  payoutDetails: optionalText(500),
  defaultDiscountPercent: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).max(100).optional(),
  ),
  usesEventOS: z.boolean().default(false),
  notes: optionalText(2000),
});

export type ProducerInput = z.input<typeof ProducerSchema>;

export async function createProducer(raw: ProducerInput, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const parsed = ProducerSchema.safeParse(raw);
  if (!parsed.success) throw new ProducerError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;
  const city = await db.city.findUnique({ where: { id: input.cityId } });
  if (!city) throw new ProducerError("Pick a city");
  return db.producer.create({
    data: {
      name: input.name,
      cityId: city.id,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      payoutDetailsEncrypted: input.payoutDetails ? encryptText(input.payoutDetails) : null,
      defaultDiscountPercent: input.defaultDiscountPercent ?? null,
      usesEventOS: input.usesEventOS,
      notes: input.notes,
    },
  });
}

export async function updateProducer(id: string, raw: ProducerInput, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const parsed = ProducerSchema.safeParse(raw);
  if (!parsed.success) throw new ProducerError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;
  const existing = await db.producer.findUnique({ where: { id } });
  if (!existing) throw new ProducerError("Producer not found");
  if (input.cityId !== existing.cityId) {
    const events = await db.event.count({ where: { producerId: id } });
    if (events > 0) throw new ProducerError("A producer with events can't change city");
    const city = await db.city.findUnique({ where: { id: input.cityId } });
    if (!city) throw new ProducerError("Pick a city");
  }
  return db.producer.update({
    where: { id },
    data: {
      name: input.name,
      cityId: input.cityId,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      ...(input.payoutDetails ? { payoutDetailsEncrypted: encryptText(input.payoutDetails) } : {}),
      defaultDiscountPercent: input.defaultDiscountPercent ?? null,
      usesEventOS: input.usesEventOS,
      notes: input.notes,
    },
  });
}

export async function clearPayoutDetails(id: string, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  return db.producer.update({ where: { id }, data: { payoutDetailsEncrypted: null } });
}

/** Decrypted payout details (ADMIN view) or a masked hint (everyone else). */
export function payoutDetails(encrypted: string | null, reveal: boolean): { masked: string | null; full: string | null } {
  if (!encrypted) return { masked: null, full: null };
  const full = decryptText(encrypted);
  const compact = full.replace(/\s+/g, "");
  const masked = compact.length > 4 ? `${"•".repeat(Math.min(compact.length - 4, 12))}${compact.slice(-4)}` : "••••";
  return { masked, full: reveal ? full : null };
}
