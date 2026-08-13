import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, seedStrategyVersion, truncateAll, type Database } from "@arf-os/db";
import { listStrategies } from "./strategy-registry.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("strategy registry pagination (integration)", () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("paginates with a cursor rather than returning everything at once", async () => {
    // Strategies are inserted back-to-back via defaultNow(), so their real
    // `created_at` carries microsecond residue below the millisecond a JS
    // Date (and thus the encoded cursor) can represent. Without
    // `precision: 3` on strategies.created_at, the cursor's `eq` branch
    // never matches the row it was built from, the `gt` branch matches
    // instead, and the boundary row is duplicated onto the next page.
    const org = await seedOrganisation(db);
    const seeded = [
      await seedStrategyVersion(db, org),
      await seedStrategyVersion(db, org),
      await seedStrategyVersion(db, org),
    ];
    const allIds = seeded.map((s) => s.strategyId);

    const firstPage = await listStrategies(db, org.organisationId, { limit: 2 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.page.items).toHaveLength(2);
    expect(firstPage.page.nextCursor).toBeDefined();

    const secondPage = await listStrategies(db, org.organisationId, { limit: 2, cursor: firstPage.page.nextCursor });
    expect(secondPage.ok).toBe(true);
    if (!secondPage.ok) return;
    expect(secondPage.page.items).toHaveLength(1);
    expect(secondPage.page.nextCursor).toBeUndefined();

    const seenIds = [...firstPage.page.items, ...secondPage.page.items].map((row) => row.id);
    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(seenIds.sort()).toEqual([...allIds].sort());
  });
});
