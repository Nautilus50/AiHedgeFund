import { defineConfig } from "vitest/config";

/** Unit suite: excludes *.integration.test.ts, which need real Postgres/Redis. */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
