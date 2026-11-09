import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { PartnerApiError } from "./errors";
import { verifyApiKey } from "./keys";

/**
 * Bearer auth + per-key rate limit for /api/partner/v1 (contract §1). The
 * limiter is an in-memory fixed window per key — good enough for one Vercel
 * region; the limit itself is the `partner_rate_limit_per_minute` setting.
 */
export type PartnerProducer = Prisma.ProducerGetPayload<{ include: { city: true } }>;

export interface PartnerContext {
  producer: PartnerProducer;
  apiKeyId: string;
  requestId: string;
}

const buckets = new Map<string, { windowStart: number; count: number }>();

export function resetRateLimitForTests(): void {
  if (process.env.NODE_ENV === "production") return;
  buckets.clear();
}

export function checkRateLimit(keyId: string, limit: number, now = new Date()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const minute = Math.floor(now.getTime() / 60_000);
  const b = buckets.get(keyId);
  if (!b || b.windowStart !== minute) {
    buckets.set(keyId, { windowStart: minute, count: 1 });
    return { ok: true };
  }
  if (b.count >= limit) return { ok: false, retryAfterSeconds: Math.max(1, 60 - Math.floor((now.getTime() % 60_000) / 1000)) };
  b.count++;
  return { ok: true };
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function requireProducerKey(req: Request, opts: { db?: PrismaClient; now?: Date; requestId?: string } = {}): Promise<PartnerContext> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const verified = await verifyApiKey(bearerToken(req), { db, now });
  if (!verified.ok) {
    throw new PartnerApiError(401, verified.code, verified.code === "producer_revoked" ? "This API key was revoked" : "Missing or invalid API key", undefined, { "www-authenticate": "Bearer" });
  }
  const limit = await getSetting("partner_rate_limit_per_minute", db);
  const rl = checkRateLimit(verified.key.id, limit, now);
  if (!rl.ok) throw new PartnerApiError(429, "rate_limited", "Too many requests", undefined, { "retry-after": String(rl.retryAfterSeconds) });
  return { producer: verified.producer, apiKeyId: verified.key.id, requestId: opts.requestId ?? crypto.randomUUID() };
}
