/**
 * Engine-less `prisma migrate deploy` (ported from EventOS): applies pending
 * migrations from prisma/migrations/ in order and records them in the standard
 * `_prisma_migrations` table, so plain `prisma migrate deploy` stays
 * interchangeable. Exists because Prisma's WASM schema engine can't talk to
 * PostgreSQL 18 — plain SQL over node-pg always can.
 *
 * Run: pnpm db:deploy            (uses DATABASE_URL)
 * Also imported by tests/global-setup.ts to prepare the test database.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "prisma", "migrations");

export async function deployMigrations(url: string, log: (m: string) => void = () => undefined): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        id                  VARCHAR(36) PRIMARY KEY,
        checksum            VARCHAR(64) NOT NULL,
        finished_at         TIMESTAMPTZ,
        migration_name      VARCHAR(255) NOT NULL,
        logs                TEXT,
        rolled_back_at      TIMESTAMPTZ,
        started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    const applied = new Set(
      (await client.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows.map(
        (r: { migration_name: string }) => r.migration_name,
      ),
    );
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    let ran = 0;
    for (const name of dirs) {
      if (applied.has(name)) continue;
      const file = join(MIGRATIONS_DIR, name, "migration.sql");
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      log(`applying ${name} …`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
           VALUES ($1, $2, now(), $3, 1)`,
          [randomUUID(), checksum, name],
        );
        await client.query("COMMIT");
        ran++;
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  deployMigrations(url, (m) => console.log(`[db-deploy] ${m}`))
    .then((n) => console.log(`[db-deploy] ${n === 0 ? "already up to date" : `applied ${n} migration(s)`}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
