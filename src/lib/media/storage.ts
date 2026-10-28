/**
 * Media storage adapter (ported from EventOS). Vercel Blob when
 * BLOB_READ_WRITE_TOKEN is set (or MEDIA_PROVIDER=vercel), local disk under
 * public/uploads/ for dev (gitignored). `get` reads a stored object back —
 * needed for encrypted ID photos, which are served through a staff-only route.
 */
import { randomUUID } from "node:crypto";

export interface StoredFile {
  url: string;
}

export interface MediaStorage {
  key: string;
  put(pathname: string, data: Buffer, contentType: string): Promise<StoredFile>;
  get(url: string): Promise<Buffer>;
  remove(url: string): Promise<void>;
}

function makeVercelBlobStorage(): MediaStorage {
  return {
    key: "vercel-blob",
    async put(pathname, data, contentType) {
      const { put } = await import("@vercel/blob");
      const blob = await put(pathname, data, { access: "public", contentType, addRandomSuffix: true });
      return { url: blob.url };
    },
    async get(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(url) {
      const { del } = await import("@vercel/blob");
      await del(url);
    },
  };
}

function localPath(url: string) {
  const path = require("node:path") as typeof import("node:path");
  return path.join(process.cwd(), "public", "uploads", path.basename(url));
}

function makeLocalStorage(): MediaStorage {
  return {
    key: "local",
    async put(pathname, data) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const safe = `${randomUUID().slice(0, 8)}-${path.basename(pathname)}`;
      const dir = path.join(process.cwd(), "public", "uploads");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, safe), data);
      return { url: `/uploads/${safe}` };
    },
    async get(url) {
      if (!url.startsWith("/uploads/")) throw new Error("not a local upload");
      const { readFile } = await import("node:fs/promises");
      return readFile(localPath(url));
    },
    async remove(url) {
      if (!url.startsWith("/uploads/")) return;
      const { rm } = await import("node:fs/promises");
      await rm(localPath(url), { force: true });
    },
  };
}

/** In-memory storage for tests. */
export function makeMemoryStorage(): MediaStorage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    key: "memory",
    files,
    async put(pathname, data) {
      const url = `memory://${randomUUID().slice(0, 8)}-${pathname.split("/").pop()}`;
      files.set(url, data);
      return { url };
    },
    async get(url) {
      const f = files.get(url);
      if (!f) throw new Error("missing");
      return f;
    },
    async remove(url) {
      files.delete(url);
    },
  };
}

let override: MediaStorage | null = null;

export function getMediaStorage(): MediaStorage {
  if (override) return override;
  const provider = process.env.MEDIA_PROVIDER;
  if (provider === "local") return makeLocalStorage();
  if (provider === "vercel" || process.env.BLOB_READ_WRITE_TOKEN) return makeVercelBlobStorage();
  return makeLocalStorage();
}

/** Test seam — inert in production. */
export function setMediaStorageForTests(storage: MediaStorage | null): void {
  if (process.env.NODE_ENV === "production") return;
  override = storage;
}
