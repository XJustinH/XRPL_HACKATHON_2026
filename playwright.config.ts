import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke tests of the demo's click path (`npm run test:e2e`). See tests/e2e/README.md.
 *
 * Runs a production build against the *_test database, which tests/e2e/global-setup.ts migrates,
 * empties and fills with the demo seed. Uses the same database as `npm run test:db`, so don't run
 * both at once. No wallet steps: those need a person approving in Xaman.
 */

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: the tests share the seeded database.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: testDatabaseUrl,
      APP_BASE_URL: baseURL,
      // Test-only value for this local server, not a real secret.
      SESSION_SECRET: "e2e-only-session-secret-not-used-anywhere-else",
      DEMO_LOGIN_ENABLED: "true",
      XRPL_NETWORK: "testnet",
    },
  },
});
