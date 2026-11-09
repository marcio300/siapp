import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { PartnerApiError } from "./errors";

/**
 * `Idempotency-Key` (contract §1): the first response to (producer, key) is
 * stored for 24 h and replayed byte-for-byte; the same key with a different
 * request → 422 idempotency_mismatch. Without the header the handler just runs.
 */
export interface PartnerResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const TTL_MS = 24 * 3_600_000;

export function requestHash(method: string, path: string, bodyText: string): string {
  return createHash("sha256").update(`${method.toUpperCase()} ${path}\n${bodyText}`).digest("hex");
}

export async function withIdempotency(
  input: { producerId: string; key: string | null; hash: string; db?: PrismaClient; now?: Date },
  handler: () => Promise<PartnerResponse>,
): Promise<PartnerResponse & { replayed?: boolean }> {
  if (!input.key) return handler();
  const db = input.db ?? defaultPrisma;
  const now = input.now ?? new Date();
  const key = input.key.slice(0, 200);
  const existing = await db.partnerIdempotency.findUnique({ where: { producerId_key: { producerId: input.producerId, key } } });
  if (existing && now.getTime() - existing.createdAt.getTime() < TTL_MS) {
    if (existing.requestHash !== input.hash) throw new PartnerApiError(422, "idempotency_mismatch", "Idempotency-Key was already used with a different request");
    return { status: existing.status, body: existing.response, replayed: true };
  }
  const res = await handler();
  if (res.status < 500) {
    await db.partnerIdempotency.upsert({
      where: { producerId_key: { producerId: input.producerId, key } },
      update: { requestHash: input.hash, status: res.status, response: res.body as Prisma.InputJsonValue, createdAt: now },
      create: { producerId: input.producerId, key, requestHash: input.hash, status: res.status, response: res.body as Prisma.InputJsonValue, createdAt: now },
    });
  }
  return res;
}
