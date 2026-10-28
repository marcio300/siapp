import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { parsePublicKey } from "./jwt";
import { PromoSchema } from "./promo";

export class PartnerCommunityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerCommunityError";
  }
}

export const PartnerCommunitySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, "Code needs at least 2 characters")
    .max(16)
    .regex(/^[A-Z0-9_]+$/, "Code: letters, digits and _ only"),
  name: z.string().trim().min(2, "Name is required").max(80),
  publicKey: z.string().trim().min(1, "Public key (PEM) is required"),
  /** JSON text from the form. */
  promo: z.string().trim().min(1, "Promo is required"),
  isActive: z.boolean().default(true),
});
export type PartnerCommunityInput = z.input<typeof PartnerCommunitySchema>;

function parse(raw: PartnerCommunityInput) {
  const parsed = PartnerCommunitySchema.safeParse(raw);
  if (!parsed.success) throw new PartnerCommunityError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;
  try {
    parsePublicKey(input.publicKey);
  } catch {
    throw new PartnerCommunityError("Public key must be an RSA public key in PEM format");
  }
  let promoJson: unknown;
  try {
    promoJson = JSON.parse(input.promo);
  } catch {
    throw new PartnerCommunityError("Promo must be valid JSON");
  }
  const promo = PromoSchema.safeParse(promoJson);
  if (!promo.success) throw new PartnerCommunityError(`Promo: ${promo.error.issues[0]?.message ?? "invalid"} — e.g. {"kind":"PLAN_PERIOD","tier":"SOCIAL","months":3}`);
  return { ...input, promo: promo.data as unknown as Prisma.InputJsonValue };
}

export async function createPartnerCommunity(raw: PartnerCommunityInput, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const data = parse(raw);
  if (await db.partnerCommunity.findUnique({ where: { code: data.code } })) throw new PartnerCommunityError(`Code ${data.code} is already taken`);
  return db.partnerCommunity.create({ data });
}

export async function updatePartnerCommunity(id: string, raw: PartnerCommunityInput, opts: { db?: PrismaClient } = {}) {
  const db = opts.db ?? defaultPrisma;
  const existing = await db.partnerCommunity.findUnique({ where: { id } });
  if (!existing) throw new PartnerCommunityError("Partner community not found");
  const data = parse(raw);
  if (data.code !== existing.code && (await db.partnerCommunity.findUnique({ where: { code: data.code } }))) throw new PartnerCommunityError(`Code ${data.code} is already taken`);
  return db.partnerCommunity.update({ where: { id }, data });
}
