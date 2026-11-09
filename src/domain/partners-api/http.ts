import { NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { PartnerApiError } from "./errors";
import { requireProducerKey, type PartnerContext } from "./auth";
import { requestHash, withIdempotency, type PartnerResponse } from "./idempotency";

/**
 * Route glue for /api/partner/v1: auth → (idempotency) → handler → JSON, with
 * `X-Request-Id` on every response and the contract's error envelope.
 */
export interface PartnerRouteOpts {
  db?: PrismaClient;
  now?: Date;
  /** Mutating routes honour `Idempotency-Key`. */
  idempotent?: boolean;
}

function json(res: PartnerResponse, requestId: string, extra: Record<string, string> = {}) {
  return NextResponse.json(res.body, { status: res.status, headers: { "x-request-id": requestId, "cache-control": "no-store", ...(res.headers ?? {}), ...extra } });
}

export function partnerErrorResponse(e: unknown, requestId: string) {
  if (e instanceof PartnerApiError) return json({ status: e.status, body: e.toBody(), headers: e.headers }, requestId);
  console.error("[partner-api]", requestId, e);
  return json({ status: 500, body: { error: { code: "internal", message: "Something went wrong on our side" } } }, requestId);
}

export async function partnerRoute(
  req: Request,
  handler: (ctx: PartnerContext, body: unknown) => Promise<PartnerResponse>,
  opts: PartnerRouteOpts = {},
) {
  const requestId = crypto.randomUUID();
  try {
    const ctx = await requireProducerKey(req, { db: opts.db, now: opts.now, requestId });
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new PartnerApiError(422, "validation_failed", "Body must be JSON", [{ field: "body", code: "invalid_json", message: "Body must be JSON" }]);
      }
    }
    const run = () => handler(ctx, body);
    const res: PartnerResponse & { replayed?: boolean } = opts.idempotent
      ? await withIdempotency({ producerId: ctx.producer.id, key: req.headers.get("idempotency-key"), hash: requestHash(req.method, new URL(req.url).pathname, bodyText), db: opts.db, now: opts.now }, run)
      : await run();
    return json(res, requestId, res.replayed ? { "idempotency-replayed": "true" } : {});
  } catch (e) {
    return partnerErrorResponse(e, requestId);
  }
}
