import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4200);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Runs the real production build, so these tests exercise the same
    // middleware and rendering path a deployment would.
    command: `pnpm start -p ${PORT}`,
    // Wait on the port rather than a 200 from `url`: every route here is
    // auth-protected, so a readiness probe expecting 2xx would never pass.
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
