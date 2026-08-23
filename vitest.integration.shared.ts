import { defineConfig } from "vitest/config";

/**
 * Shared config for integration suites. They run against real Postgres and
 * Redis, so: only *.integration.test.ts files, a longer timeout than the
 * unit default, and fully sequential execution — several suites truncate the
 * same tables, and both parallel workers (singleFork) and interleaved files
 * within one worker (fileParallelism) would race each other.
 */
export const integrationConfig = defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});

export default integrationConfig;
