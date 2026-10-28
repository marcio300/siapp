import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration-style tests against a REAL Postgres (the ledger/allocation
 * invariants in docs/DATA_MODEL.md can't be proven against mocks).
 * tests/global-setup.ts provides the database: TEST_DATABASE_URL when set
 * (e.g. a Neon branch), otherwise an embedded Postgres on port 5434.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // One worker: tests share the database and truncate between files.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    environment: "node",
  },
});
