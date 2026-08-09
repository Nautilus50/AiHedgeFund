import { defineConfig } from "vitest/config";

/**
 * Vitest must not pick up the Playwright specs in e2e/ — they use
 * @playwright/test's own runner and throw if evaluated by vitest.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
