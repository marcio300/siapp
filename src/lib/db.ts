import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Prisma client singleton (ported from EventOS). Runs engine-less
 * (engineType "client": WASM query compiler) over the node-postgres driver
 * adapter — no native Prisma engine binary required at runtime.
 *
 * Business rules live in src/domain/*; this module only hands out the client.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function makePrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env or run `pnpm dev:local`");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
