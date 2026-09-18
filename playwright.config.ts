import { defineConfig, devices } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./tests/e2e/global-setup";

// spec §68: E2E tests against a real, reachable Postgres (a Neon instance —
// see PROJECT_ANALYSIS.md). `globalSetup` creates a real `Session` row for
// the seeded demo user and writes a matching storageState so
// `full-flow.spec.ts` runs authenticated without a scripted magic-link
// click (Auth.js's real flow has no inbox to click from headlessly).
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: require.resolve("./tests/e2e/global-setup.ts"),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", testMatch: /smoke\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium-authenticated",
      testMatch: /full-flow\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE_PATH },
    },
  ],
  // No `webServer` block: this repo's dev server needs REDIS_URL unset
  // (BullMQ needs Redis >= 6.2; the bundled dev Redis is 3.2 — see
  // PROJECT_ANALYSIS.md) so `full-flow.spec.ts` exercises the manual
  // Generate/Approve/Send buttons instead of the automatic queue pipeline.
  // Start `npm run dev` yourself (with REDIS_URL unset) before
  // `npm run test:e2e`.
});
