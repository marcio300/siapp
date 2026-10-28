/**
 * Shared helper for booting the embedded Postgres that `pnpm dev:local` and
 * the Vitest global setup use. Binaries come from the `embedded-postgres`
 * devDependency (downloaded by pnpm — nothing else to install).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import type EmbeddedPostgres from "embedded-postgres";

export const ROOT = path.resolve(__dirname, "..");

export function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  u.search = "";
  return u.toString();
}

export function databaseName(url: string, fallback: string): string {
  const name = new URL(url).pathname.replace(/^\//, "");
  return name || fallback;
}

export async function canConnect(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runSql(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove a stale postmaster.pid + socket files after an unclean shutdown. */
function cleanStaleServerFiles(dataDir: string, port: number, log: (m: string) => void): void {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!fs.existsSync(pidFile)) return;
  const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").split("\n")[0] ?? "", 10);
  if (Number.isFinite(pid) && pidAlive(pid)) return;
  fs.rmSync(pidFile, { force: true });
  for (const dir of new Set(["/tmp", os.tmpdir()])) {
    for (const file of [`.s.PGSQL.${port}`, `.s.PGSQL.${port}.lock`]) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }
  log("removed stale postmaster.pid from a previous unclean shutdown");
}

/**
 * The Linux binaries ship ICU as `libicuuc.so.60.2` etc. but link against the
 * SONAME `libicuuc.so.60`; npm tarballs can't carry symlinks, so on a fresh
 * install the loader can't find them. Create the missing `lib*.so.N` links
 * next to the versioned files (best effort, Linux only).
 */
function ensureSharedLibSymlinks(log: (m: string) => void): void {
  if (process.platform !== "linux") return;
  // The package's `exports` map hides package.json from require.resolve, so
  // locate it by walking up from here to the nearest node_modules.
  let libDir: string | null = null;
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "@embedded-postgres", `linux-${process.arch}`, "native", "lib");
    if (fs.existsSync(candidate)) {
      libDir = candidate;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  if (!libDir) return;
  if (!fs.existsSync(libDir)) return;
  let created = 0;
  for (const file of fs.readdirSync(libDir)) {
    const m = file.match(/^(lib[^.]+\.so\.\d+)\.\d+(?:\.\d+)*$/);
    if (!m) continue;
    const link = path.join(libDir, m[1]!);
    if (fs.existsSync(link)) continue;
    try {
      fs.symlinkSync(file, link);
      created++;
    } catch {
      /* read-only node_modules — the start() error below will say what's missing */
    }
  }
  if (created > 0) log(`linked ${created} shared libraries for the embedded Postgres binaries`);
}

/**
 * Start (or reuse) an embedded Postgres on `port` with data in `dataDir`.
 * Returns the instance when we started it (stop it on exit), or null when a
 * server was already listening and we just reuse it.
 */
export async function startEmbedded(opts: {
  dataDir: string;
  port: number;
  log?: (m: string) => void;
}): Promise<EmbeddedPostgres | null> {
  const log = opts.log ?? (() => undefined);
  const url = `postgresql://postgres:password@localhost:${opts.port}/postgres`;
  if (await canConnect(url)) {
    log(`Postgres already running on port ${opts.port} — reusing it`);
    return null;
  }
  cleanStaleServerFiles(opts.dataDir, opts.port, log);
  ensureSharedLibSymlinks(log);
  const { default: EmbeddedPostgresClass } = await import("embedded-postgres");
  const serverLogs: string[] = [];
  const instance = new EmbeddedPostgresClass({
    databaseDir: opts.dataDir,
    port: opts.port,
    user: "postgres",
    password: "password",
    persistent: true,
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    onLog: (m) => serverLogs.push(String(m)),
    onError: (m) => serverLogs.push(String(m)),
  });
  const fresh = !fs.existsSync(path.join(opts.dataDir, "PG_VERSION"));
  try {
    if (fresh) {
      if (fs.existsSync(opts.dataDir) && fs.readdirSync(opts.dataDir).length > 0) {
        log(`clearing incomplete ${path.basename(opts.dataDir)} from a previous failed initialisation …`);
        fs.rmSync(opts.dataDir, { recursive: true, force: true });
      }
      log(`first run — initialising embedded Postgres in ${path.relative(ROOT, opts.dataDir)}/ …`);
      await instance.initialise();
    }
    await instance.start();
  } catch (error) {
    process.stderr.write(serverLogs.join(""));
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(`Embedded Postgres failed to start${detail}. Is port ${opts.port} taken? (data dir: ${opts.dataDir})`);
  }
  log(`embedded Postgres running on port ${opts.port}`);
  return instance;
}

export async function ensureDatabase(url: string, fallbackName: string, log: (m: string) => void = () => undefined): Promise<void> {
  const name = databaseName(url, fallbackName);
  const client = new Client({ connectionString: adminUrl(url) });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
      log(`created database "${name}"`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function dropDatabase(url: string, fallbackName: string): Promise<void> {
  const name = databaseName(url, fallbackName);
  const client = new Client({ connectionString: adminUrl(url) });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
