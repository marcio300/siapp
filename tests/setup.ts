/**
 * Per-file setup: point the Prisma singleton at the test database before any
 * test file imports src/lib/db, and give the libs the env they expect.
 */
import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.AUTH_SECRET ??= "test-secret-not-for-production";
process.env.APP_URL ??= "http://localhost:3000";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
delete process.env.EMAIL_API_KEY; // console email in tests
delete process.env.TEST_STAFF_EMAIL;
