/**
 * Create the SIAPP e2e database, apply migrations and seed. Reads DATABASE_URL
 * from .env (dotenv via tsx is not automatic — we load it here).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deployMigrations } from "../db-deploy";
import { ROOT, ensureDatabase } from "../embedded-pg";

function loadEnv() {
  const p = path.join(ROOT, ".env");
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();
const url = process.env.DATABASE_URL!;
const log = (m: string) => console.log(`[setup-db] ${m}`);
(async () => {
  await ensureDatabase(url, "siapp", log);
  const n = await deployMigrations(url, log);
  log(`applied ${n} migration(s)`);
  execSync("pnpm exec tsx prisma/seed.ts", { cwd: ROOT, env: process.env, stdio: "inherit" });
  log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
