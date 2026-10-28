/**
 * Vitest global setup: provide a real Postgres with the schema applied.
 *
 *   TEST_DATABASE_URL set  → use that database (e.g. a Neon branch; see README "Testing")
 *   otherwise              → boot an embedded Postgres on port 5434 (data in .testdb/)
 *
 * Either way the suite TRUNCATES tables between files — never point it at a
 * database you care about.
 */
import "dotenv/config";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { deployMigrations } from "../scripts/db-deploy";
import { ROOT, ensureDatabase, startEmbedded } from "../scripts/embedded-pg";

const PORT = 5434;
const EMBEDDED_URL = `postgresql://postgres:password@localhost:${PORT}/siapp_test`;

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const log = (m: string) => console.log(`[test-db] ${m}`);
  let url = process.env.TEST_DATABASE_URL?.trim();
  let instance: Awaited<ReturnType<typeof startEmbedded>> = null;

  if (url) {
    log(`using TEST_DATABASE_URL (${url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@")})`);
  } else {
    url = EMBEDDED_URL;
    instance = await startEmbedded({ dataDir: path.join(ROOT, ".testdb"), port: PORT, log });
    await ensureDatabase(url, "siapp_test", log);
  }

  const applied = await deployMigrations(url, log);
  log(applied === 0 ? "schema up to date" : `applied ${applied} migration(s)`);
  project.provide("databaseUrl", url);

  return async () => {
    if (instance) await instance.stop().catch(() => undefined);
  };
}
