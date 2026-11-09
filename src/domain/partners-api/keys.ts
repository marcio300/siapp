import { createHash, randomInt } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Producer API keys (contract §1.1): `siapp_pk_<prefix 8>_<secret 32>`, base62.
 * Only the sha256 of the whole key is stored (plus the prefix for display).
 * One ACTIVE key per producer: generating a new one revokes the old one.
 */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const API_KEY_RE = /^siapp_pk_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

function b62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += B62[randomInt(0, B62.length)];
  return out;
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const prefix = b62(8);
  const plain = `siapp_pk_${prefix}_${b62(32)}`;
  return { plain, prefix, hash: hashApiKey(plain) };
}

type Db = PrismaClient | Prisma.TransactionClient;
type Opts = { db?: Db; now?: Date };

/** ADMIN action: mint a key (shown once), revoking any active one. */
export async function createProducerApiKey(producerId: string, createdById: string | null, opts: Opts = {}) {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const producer = await db.producer.findUnique({ where: { id: producerId } });
  if (!producer) throw new Error("Producer not found");
  await db.producerApiKey.updateMany({ where: { producerId, revokedAt: null }, data: { revokedAt: now } });
  const key = generateApiKey();
  const row = await db.producerApiKey.create({ data: { producerId, prefix: key.prefix, keyHash: key.hash, createdById, createdAt: now } });
  return { plain: key.plain, row };
}

export async function revokeProducerApiKeys(producerId: string, opts: Opts = {}): Promise<number> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const res = await db.producerApiKey.updateMany({ where: { producerId, revokedAt: null }, data: { revokedAt: now } });
  return res.count;
}

export type VerifiedKey =
  | { ok: true; producer: Prisma.ProducerGetPayload<{ include: { city: true } }>; key: Prisma.ProducerApiKeyGetPayload<Record<string, never>> }
  | { ok: false; code: "unauthorized" | "producer_revoked" };

/** Bearer → producer. Stamps `lastUsedAt` (best effort, outside any lock). */
export async function verifyApiKey(plain: string | null | undefined, opts: Opts = {}): Promise<VerifiedKey> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  if (!plain || !API_KEY_RE.test(plain.trim())) return { ok: false, code: "unauthorized" };
  const row = await db.producerApiKey.findUnique({ where: { keyHash: hashApiKey(plain.trim()) }, include: { producer: { include: { city: true } } } });
  if (!row) return { ok: false, code: "unauthorized" };
  if (row.revokedAt) return { ok: false, code: "producer_revoked" };
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.producerApiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => undefined);
  }
  const { producer, ...key } = row;
  return { ok: true, producer, key };
}
