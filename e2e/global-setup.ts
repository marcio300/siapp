/**
 * Boots a dedicated embedded Postgres, applies migrations, seeds, and provisions the fixtures the
 * flow needs (producer + three published events). Writes e2e/.state.json for the spec.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { deployMigrations } from "../scripts/db-deploy";
import { ROOT, ensureDatabase, startEmbedded } from "../scripts/embedded-pg";
import { E2E_DB_URL, OUTBOX } from "../playwright.config";

export default async function globalSetup() {
  const log = (m: string) => console.log(`[e2e-db] ${m}`);
  process.env.DATABASE_URL = E2E_DB_URL;
  const instance = await startEmbedded({ dataDir: path.join(ROOT, ".e2edb"), port: 5435, log });
  await ensureDatabase(E2E_DB_URL, "siapp_e2e", log);
  await deployMigrations(E2E_DB_URL, log);
  rmSync(path.join(ROOT, OUTBOX), { recursive: true, force: true });
  mkdirSync(path.join(ROOT, OUTBOX), { recursive: true });

  // Provision through tsx: Playwright's loader doesn't resolve the `@/` alias used inside src/.
  execFileSync("pnpm", ["exec", "tsx", "e2e/provision.ts"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, DATABASE_URL: E2E_DB_URL, AUTH_SECRET: "e2e-secret-not-for-production" } });
  return async () => {
    if (instance) await instance.stop().catch(() => undefined);
  };
}
