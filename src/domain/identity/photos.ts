import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { decryptFile, encryptFile } from "@/lib/media/crypto";
import { getMediaStorage } from "@/lib/media/storage";

/**
 * Selfie (required before the first redemption, shown on every scanned ticket)
 * and tourist ID photo (required to buy the weekly pass; encrypted at rest,
 * reviewed in the backoffice, purged after 30 days). Spec §10.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
export const ID_PHOTO_RETENTION_DAYS = 30;

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

export interface PhotoInput {
  data: Buffer;
  contentType: string;
}

function validate(input: PhotoInput) {
  if (input.data.length === 0) throw new PhotoError("No photo received");
  if (input.data.length > MAX_PHOTO_BYTES) throw new PhotoError("Photo too large (max 8 MB)");
  if (!PHOTO_TYPES.has(input.contentType)) throw new PhotoError("Use a JPEG, PNG or WebP photo");
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };

export async function storeSelfie(memberId: string, input: PhotoInput, opts: { db?: PrismaClient; now?: Date } = {}) {
  validate(input);
  const db = opts.db ?? defaultPrisma;
  const storage = getMediaStorage();
  const stored = await storage.put(`selfies/${memberId}.${EXT[input.contentType]}`, input.data, input.contentType);
  const previous = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { selfieUrl: true } });
  await db.member.update({
    where: { id: memberId },
    data: { selfieUrl: stored.url, selfieUploadedAt: opts.now ?? new Date() },
  });
  if (previous.selfieUrl && previous.selfieUrl !== stored.url) await storage.remove(previous.selfieUrl).catch(() => undefined);
  return stored.url;
}

export async function storeIdPhoto(memberId: string, input: PhotoInput, opts: { db?: PrismaClient; now?: Date } = {}) {
  validate(input);
  const db = opts.db ?? defaultPrisma;
  const storage = getMediaStorage();
  const encrypted = encryptFile(input.data, input.contentType);
  const stored = await storage.put(`id-photos/${memberId}.bin`, encrypted, "application/octet-stream");
  const previous = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { idPhotoUrl: true } });
  await db.member.update({
    where: { id: memberId },
    data: { idPhotoUrl: stored.url, idPhotoUploadedAt: opts.now ?? new Date() },
  });
  if (previous.idPhotoUrl && previous.idPhotoUrl !== stored.url) await storage.remove(previous.idPhotoUrl).catch(() => undefined);
  return stored.url;
}

/** Staff-only read: fetch + decrypt. */
export async function readIdPhoto(memberId: string, opts: { db?: PrismaClient } = {}): Promise<{ data: Buffer; mime: string } | null> {
  const db = opts.db ?? defaultPrisma;
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { idPhotoUrl: true } });
  if (!member.idPhotoUrl) return null;
  const blob = await getMediaStorage().get(member.idPhotoUrl);
  return decryptFile(blob);
}

export async function deleteIdPhoto(memberId: string, opts: { db?: PrismaClient } = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { idPhotoUrl: true } });
  if (!member.idPhotoUrl) return false;
  await getMediaStorage().remove(member.idPhotoUrl).catch(() => undefined);
  await db.member.update({ where: { id: memberId }, data: { idPhotoUrl: null, idPhotoUploadedAt: null } });
  return true;
}

/** Daily job: delete ID photos older than 30 days. */
export async function purgeIdPhotos(opts: { db?: PrismaClient; now?: Date } = {}): Promise<{ purged: number }> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - ID_PHOTO_RETENTION_DAYS * 86_400_000);
  const stale = await db.member.findMany({
    where: { idPhotoUrl: { not: null }, idPhotoUploadedAt: { lte: cutoff } },
    select: { id: true },
  });
  let purged = 0;
  for (const m of stale) if (await deleteIdPhoto(m.id, { db })) purged++;
  return { purged };
}
