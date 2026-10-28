import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isProductionRuntime } from "@/lib/runtime-env";

/**
 * Encryption at rest (spec §10 ID photos, §5 producer payout details):
 * AES-256-GCM with a key from DATA_ENCRYPTION_KEY (base64, 32 bytes;
 * ID_PHOTO_KEY is accepted as a legacy name). Outside production a key
 * derived from AUTH_SECRET is used so local dev needs no extra config.
 * File layout: [1 byte header length][header JSON {mime}][12 iv][16 tag][ciphertext].
 * Text layout: base64 of [12 iv][16 tag][ciphertext].
 */
function key(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? process.env.ID_PHOTO_KEY;
  if (raw) {
    const k = Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return k;
  }
  if (isProductionRuntime()) throw new Error("DATA_ENCRYPTION_KEY is not set — encrypted fields cannot be stored in production without it");
  return createHash("sha256").update(`id-photo:${process.env.AUTH_SECRET ?? "dev"}`).digest();
}

export function encryptText(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptText(encoded: string): string {
  const blob = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

export function encryptFile(data: Buffer, mime: string): Buffer {
  const header = Buffer.from(JSON.stringify({ mime }), "utf8");
  if (header.length > 255) throw new Error("header too long");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([header.length]), header, iv, tag, ciphertext]);
}

export function decryptFile(blob: Buffer): { data: Buffer; mime: string } {
  const headerLength = blob[0]!;
  const header = JSON.parse(blob.subarray(1, 1 + headerLength).toString("utf8")) as { mime: string };
  let offset = 1 + headerLength;
  const iv = blob.subarray(offset, offset + 12);
  offset += 12;
  const tag = blob.subarray(offset, offset + 16);
  offset += 16;
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(blob.subarray(offset)), decipher.final()]);
  return { data, mime: header.mime };
}
