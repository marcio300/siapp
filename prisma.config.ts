// Prisma config — enables engine-less migrations (db push / migrate) through the
// pg driver adapter. Needed in environments where Prisma's native schema-engine
// binary cannot be downloaded; harmless everywhere else.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
  experimental: {
    adapter: true,
  },
  engine: "js",
  async adapter() {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    return new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  },
});
