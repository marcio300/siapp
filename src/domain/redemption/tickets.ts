import { createHmac, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Tickets (EventOS format): the QR encodes an opaque unguessable token that
 * the scanner resolves server-side. We additionally store an HMAC signature
 * so Phase 6's offline mode can verify a cached ticket without the DB.
 */
export function newQrPayload(): string {
  return randomBytes(16).toString("hex");
}

export function signQrPayload(payload: string): string {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "dev").update(payload).digest("base64url");
}

export function verifyQrSignature(payload: string, signature: string): boolean {
  return signQrPayload(payload) === signature;
}

export async function issueTicket(
  db: PrismaClient | Prisma.TransactionClient,
  input: { redemptionId: string; memberName: string; photoSnapshotUrl: string | null; plusOneName: string | null },
) {
  const qrPayload = newQrPayload();
  return db.ticket.create({
    data: {
      redemptionId: input.redemptionId,
      qrPayload,
      signature: signQrPayload(qrPayload),
      memberName: input.memberName,
      photoSnapshotUrl: input.photoSnapshotUrl,
      plusOneName: input.plusOneName,
    },
  });
}
