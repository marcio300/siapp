import { createHmac, randomBytes } from "node:crypto";
import { Prisma, type OutboundEvent, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { webhookSecrets } from "./connect";

/**
 * Signed messages to a producer's EventOS (contract docs/SIAPP_API.md §1.2 +
 * §4). Every message is an `OutboundEvent` row first (the outbox), then
 * delivered by `flushOutbound` — from the cron job, or right away by the hook
 * that queued it. Retries back off 1 m / 5 m / 15 m / 1 h / 6 h and the row
 * goes FAILED after the sixth failure or on a terminal 4xx (anything but
 * 408 / 429). Replies are stored on the row and handed to `onDelivered`, which
 * is how `redemption.activated` learns the EventOS ticket id.
 */
export type OutboundType =
  | "redemption.activated"
  | "redemption.cancelled"
  | "ticket.checked_in"
  | "sales.updated"
  | "producer.disconnected";

export interface Envelope {
  id: string;
  type: OutboundType;
  producerId: string;
  eventosOrgId: string;
  createdAt: string;
  data: unknown;
}

/** Backoff after the n-th failure (index 0 = first failure). The next failure past the list → FAILED. */
export const OUTBOUND_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000] as const;

// ULID (Crockford base32: 48-bit ms timestamp + 80 random bits) — the envelope id, sortable by time.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = new Date()): string {
  let t = now.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i]! % 32];
  return time + rand;
}

export function signEnvelope(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, body: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${signEnvelope(secret, t, body)}`;
}

let testFetch: typeof fetch | null = null;
/** Test seam: every outbound delivery goes through this fetch when set (inert in production). */
export function setOutboundFetchForTests(fn: typeof fetch | null): void {
  if (process.env.NODE_ENV === "production") return;
  testFetch = fn;
}
/** The fetch outbound calls use right now (the test seam when set) — shared with the synchronous `order.create` command. */
export function currentOutboundFetch(): typeof fetch {
  return testFetch ?? fetch;
}

type Db = PrismaClient | Prisma.TransactionClient;
type ProducerLite = { id: string; eventosOrgId: string | null; eventosWebhookUrl: string | null };

export interface QueueOpts {
  db?: Db;
  now?: Date;
  /** The SIAPP event the message is about (backoffice log). */
  eventId?: string | null;
  /** Coalesce: one live row per key (`sales.updated`); a SENT/FAILED row is re-armed, a PENDING one is left alone. */
  dedupeKey?: string;
  /** Earliest delivery (coalescing window). */
  notBefore?: Date;
}

/** Store a message for the producer's EventOS. Returns null when the producer isn't connected. */
export async function queueOutbound(producer: ProducerLite, type: OutboundType, data: unknown, opts: QueueOpts = {}): Promise<OutboundEvent | null> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  if (!producer.eventosOrgId || !producer.eventosWebhookUrl) return null;
  const payload = data as Prisma.InputJsonValue;
  const nextAttemptAt = opts.notBefore && opts.notBefore > now ? opts.notBefore : now;
  if (opts.dedupeKey) {
    const existing = await db.outboundEvent.findUnique({ where: { dedupeKey: opts.dedupeKey } });
    if (existing?.status === "PENDING") return existing;
    if (existing) {
      return db.outboundEvent.update({
        where: { id: existing.id },
        data: { id: ulid(now), payload, status: "PENDING", attempts: 0, nextAttemptAt, lastError: null, responseStatus: null, responseBody: Prisma.DbNull, sentAt: null, createdAt: now },
      });
    }
  }
  return db.outboundEvent.create({
    data: { id: ulid(now), producerId: producer.id, eventId: opts.eventId ?? null, type, payload, dedupeKey: opts.dedupeKey ?? null, nextAttemptAt, createdAt: now },
  });
}

export interface FlushOpts {
  db?: PrismaClient;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Only these rows (immediate delivery after queueing). */
  ids?: string[];
  limit?: number;
  /** Called after a 2xx with the parsed reply body. */
  onDelivered?: (row: OutboundEvent, reply: unknown, db: PrismaClient) => Promise<void>;
}

export interface FlushReport {
  sent: number;
  retried: number;
  failed: number;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function envelopeFor(row: OutboundEvent, eventosOrgId: string): Envelope {
  return { id: row.id, type: row.type as OutboundType, producerId: row.producerId, eventosOrgId, createdAt: row.createdAt.toISOString(), data: row.payload };
}

/** Deliver due rows. Each row is attempted once per flush; failures reschedule or finalise it. */
export async function flushOutbound(opts: FlushOpts = {}): Promise<FlushReport> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? testFetch ?? fetch;
  const onDelivered = opts.onDelivered ?? defaultOnDelivered;
  const rows = await db.outboundEvent.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now }, ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
    include: { producer: true },
  });
  const report: FlushReport = { sent: 0, retried: 0, failed: 0 };
  for (const row of rows) {
    const p = row.producer;
    const [secret] = webhookSecrets(p, now);
    if (!p.eventosWebhookUrl || !p.eventosOrgId || !secret) {
      await db.outboundEvent.update({ where: { id: row.id }, data: { status: "FAILED", attempts: { increment: 1 }, lastError: "producer not connected to EventOS" } });
      report.failed++;
      continue;
    }
    const body = JSON.stringify(envelopeFor(row, p.eventosOrgId));
    let status = 0;
    let text = "";
    let error: string | null = null;
    try {
      const res = await fetchImpl(p.eventosWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-siapp-signature": signatureHeader(secret, body, now), "x-request-id": row.id },
        body,
      });
      status = res.status;
      text = await res.text().catch(() => "");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    let reply: unknown = null;
    if (text) {
      try {
        reply = JSON.parse(text);
      } catch {
        reply = text.slice(0, 2000);
      }
    }
    const replyJson = (reply ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull;
    if (status >= 200 && status < 300) {
      await db.outboundEvent.update({ where: { id: row.id }, data: { status: "SENT", attempts: { increment: 1 }, sentAt: now, responseStatus: status, responseBody: replyJson, lastError: null } });
      report.sent++;
      try {
        await onDelivered(row, reply, db);
      } catch (e) {
        console.error("[partner-outbox] onDelivered failed", row.id, e);
      }
      continue;
    }
    const attempts = row.attempts + 1;
    const lastError = error ?? `HTTP ${status}${text ? `: ${text.slice(0, 500)}` : ""}`;
    const retryable = error !== null || isRetryable(status);
    const backoff = OUTBOUND_BACKOFF_MS[attempts - 1];
    if (retryable && backoff !== undefined) {
      await db.outboundEvent.update({ where: { id: row.id }, data: { attempts, nextAttemptAt: new Date(now.getTime() + backoff), lastError, responseStatus: status || null, responseBody: replyJson } });
      report.retried++;
    } else {
      await db.outboundEvent.update({ where: { id: row.id }, data: { status: "FAILED", attempts, lastError, responseStatus: status || null, responseBody: replyJson } });
      report.failed++;
    }
  }
  return report;
}

/** Staff: put a FAILED row back in the queue (fresh attempt count). */
export async function retryOutbound(id: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const res = await db.outboundEvent.updateMany({ where: { id, status: "FAILED" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lastError: null } });
  return res.count > 0;
}

/** Store what EventOS answered where we keep a reference to it. */
export async function defaultOnDelivered(row: OutboundEvent, reply: unknown, db: PrismaClient): Promise<void> {
  if (row.type !== "redemption.activated") return;
  const data = row.payload as { redemptionId?: string };
  const r = reply as { ticketId?: unknown; orderId?: unknown } | null;
  if (!data?.redemptionId || !r || typeof r !== "object") return;
  const ticketId = typeof r.ticketId === "string" ? r.ticketId : null;
  const orderId = typeof r.orderId === "string" ? r.orderId : null;
  if (!ticketId && !orderId) return;
  await db.ticket.updateMany({ where: { redemptionId: data.redemptionId }, data: { ...(ticketId ? { externalTicketId: ticketId } : {}), ...(orderId ? { externalOrderId: orderId } : {}) } });
}
