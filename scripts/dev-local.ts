/**
 * One-command local dev environment (ported from EventOS).
 *
 *   pnpm install && pnpm dev:local
 *
 * Boots an embedded Postgres on port 5433 (data in ./.devdb), creates .env on
 * first run, applies migrations + seed, then starts `next dev`. Idempotent.
 *
 * Flags:
 *   --no-app   everything except starting Next, then shut down (CI / sandbox)
 *   --reset    drop and recreate the dev database first (all local data wiped)
 *
 * If .env already exists it is never modified; when its DATABASE_URL points
 * somewhere other than localhost:5433 (e.g. a Neon branch) the embedded
 * server is skipped and that database is used as-is.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deployMigrations } from "./db-deploy";
import { ROOT, canConnect, dropDatabase, ensureDatabase, startEmbedded } from "./embedded-pg";

const DATA_DIR = path.join(ROOT, ".devdb");
const PORT = 5433;
const DEFAULT_URL = `postgresql://postgres:password@localhost:${PORT}/siapp`;
const NO_APP = process.argv.includes("--no-app");
const RESET = process.argv.includes("--reset");

const log = (msg: string) => console.log(`[dev-local] ${msg}`);
const redact = (url: string) => url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");

/** Create .env from .env.example on first run; never touch an existing one. */
function ensureEnv(): string {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const secret = randomBytes(32).toString("base64");
    const filled = example
      .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="${DEFAULT_URL}"`)
      .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${secret}"`);
    fs.writeFileSync(envPath, filled);
    log(".env created from .env.example (embedded DB on port 5433, AUTH_SECRET generated)");
    return DEFAULT_URL;
  }
  const content = fs.readFileSync(envPath, "utf8");
  const match = content.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+?)"?\s*$/m);
  if (match?.[1]?.trim()) return match[1].trim();
  log(".env exists but has no DATABASE_URL — using the embedded default (file left untouched)");
  return DEFAULT_URL;
}

function isEmbeddedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname === "" ? "localhost" : u.hostname) &&
      (u.port === "" ? "5432" : u.port) === String(PORT)
    );
  } catch {
    return false;
  }
}

function run(command: string, env: NodeJS.ProcessEnv): void {
  execSync(command, { cwd: ROOT, env, stdio: "inherit" });
}

async function main(): Promise<void> {
  const url = ensureEnv();
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };

  let instance = null as Awaited<ReturnType<typeof startEmbedded>>;
  if (isEmbeddedUrl(url)) {
    instance = await startEmbedded({ dataDir: DATA_DIR, port: PORT, log });
    if (RESET) {
      log("resetting dev database — all local data wiped");
      await dropDatabase(url, "siapp");
    }
    await ensureDatabase(url, "siapp", log);
  } else {
    log(`DATABASE_URL points at an external database (${redact(url)}) — skipping embedded Postgres`);
    if (RESET) {
      await dropDatabase(url, "siapp");
      await ensureDatabase(url, "siapp", log);
    } else if (!(await canConnect(url))) {
      throw new Error(`Cannot connect to ${redact(url)} — is that database running?`);
    }
  }

  log("generating Prisma client …");
  run("pnpm exec prisma generate", env);
  const applied = await deployMigrations(url, log);
  log(applied === 0 ? "migrations already up to date" : `applied ${applied} migration(s)`);
  log("seeding (city, tiers, plans, packs, settings, admin) …");
  run("pnpm exec tsx prisma/seed.ts", env);

  if (NO_APP) {
    log("--no-app: setup complete, shutting down");
    if (instance) await instance.stop();
    process.exit(0);
  }

  console.log(`
──────────────────────────────────────────────────────────────
  SIAPP — local dev

  Member app    http://localhost:3000/app
  Backoffice    http://localhost:3000/admin
  Sign-in       http://localhost:3000/sign-in

  Staff sign-in: ${env.SEED_ADMIN_EMAIL ?? "SEED_ADMIN_EMAIL in .env"} (ADMIN)
  Magic links print to THIS console (no email API key needed).

  Stop with Ctrl+C — the embedded Postgres shuts down too.
──────────────────────────────────────────────────────────────
`);
  const nextBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  const child: ChildProcess = spawn(nextBin, ["dev"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode === null && !child.killed) child.kill("SIGINT");
    if (instance) {
      log("stopping embedded Postgres …");
      await instance.stop().catch(() => undefined);
    }
    process.exit(code);
  };
  child.on("exit", (code) => void shutdown(code ?? 0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch((error) => {
  console.error(`[dev-local] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
