import { defineConfig, devices } from "@playwright/test";

/**
 * Critical-path e2e (docs/BUILD_PLAN.md Phase 10): signup → subscribe (synthetic Stripe webhooks)
 * → redeem a free offer → scan OK → cancel outside / inside the window.
 *
 * `pnpm e2e` boots an embedded Postgres on 5435 (e2e/global-setup.ts), seeds it, starts `next dev`
 * on :3100 with the console email adapter writing to e2e/.outbox, and runs the flow headless.
 * Don't run it while `pnpm dev` is up — both use the .next folder.
 */
const PORT = 3100;
export const E2E_DB_URL = "postgresql://postgres:password@localhost:5435/siapp_e2e";
export const OUTBOX = "e2e/.outbox";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", ...devices["Pixel 7"] },
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DB_URL,
      AUTH_SECRET: "e2e-secret-not-for-production",
      AUTH_URL: `http://localhost:${PORT}`,
      AUTH_TRUST_HOST: "true",
      APP_URL: `http://localhost:${PORT}`,
      EMAIL_OUTBOX_DIR: OUTBOX,
      EMAIL_API_KEY: "",
      STRIPE_SECRET_KEY: "sk_test_unused",
      STRIPE_WEBHOOK_SECRET: "whsec_e2e",
      SEED_ADMIN_EMAIL: "admin@e2e.siapp",
      CRON_SECRET: "e2e-cron",
    },
  },
});
