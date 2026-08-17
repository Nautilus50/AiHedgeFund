import { expect, test } from "@playwright/test";

/**
 * ARF-OS has no anonymous read surface: every research route must send an
 * unauthenticated visitor to sign-in before rendering anything (spec 17).
 * These run against the production build via playwright.config.ts, so they
 * exercise the same middleware a deployment would.
 */
const NIL_ID = "00000000-0000-0000-0000-000000000000";

const PROTECTED_ROUTES = [
  { path: "/", name: "Command Centre" },
  { path: "/campaigns/new", name: "New campaign" },
  { path: `/campaigns/${NIL_ID}`, name: "Campaign detail" },
  { path: "/strategies", name: "Strategy Library" },
  { path: "/strategies/import", name: "Import strategy" },
  { path: `/strategy-versions/${NIL_ID}`, name: "Strategy version detail" },
  { path: `/strategy-versions/${NIL_ID}/backtest-runs/new`, name: "New backtest run" },
  { path: `/strategy-versions/${NIL_ID}/forward-deployments/new`, name: "New forward deployment" },
  { path: `/backtest-runs/${NIL_ID}`, name: "Backtest run detail" },
  { path: `/backtest-runs/${NIL_ID}/validation`, name: "Validation Lab" },
  { path: `/forward-deployments/${NIL_ID}`, name: "Forward deployment detail" },
  { path: `/forward-deployments/${NIL_ID}/drift`, name: "Forward deployment drift report" },
  { path: `/verifications/${NIL_ID}`, name: "Verification upload" },
  { path: "/portfolio-research", name: "Portfolio Research" },
  { path: "/practice-arena", name: "Practice Arena" },
  { path: `/practice-arena/${NIL_ID}`, name: "Practice Arena task detail" },
];

test.describe("authentication boundary", () => {
  for (const route of PROTECTED_ROUTES) {
    test(`${route.name} (${route.path}) redirects to sign-in while signed out`, async ({ page }) => {
      await page.goto(route.path);

      await page.waitForURL(/\/sign-in/, { timeout: 20_000 });
      await expect(page.getByText(/sign in/i).first()).toBeVisible({ timeout: 20_000 });

      // The console must not have rendered behind the redirect.
      // Must match the real h1 exactly — an assertion for text that never
      // exists would pass vacuously and prove nothing.
      await expect(page.getByRole("heading", { name: /^Command Centre$/i })).toHaveCount(0);
    });
  }

  test("the sign-in page itself is publicly reachable", async ({ page }) => {
    const response = await page.goto("/sign-in");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByText(/sign in/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test("does not leak research data in the signed-out response body", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    const body = await response.text();

    // A signed-out response should never carry campaign or strategy
    // payloads — only the shell and Clerk's redirect scaffolding.
    expect(body).not.toMatch(/Integration test campaign/i);
    expect(body).not.toMatch(/strategyVersionId/i);
  });
});
