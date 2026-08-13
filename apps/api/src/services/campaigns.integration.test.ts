import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { campaigns, closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, truncateAll, type Database } from "@arf-os/db";
import { listCampaigns } from "./campaigns.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("campaigns pagination (integration)", () => {
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
    // Campaigns are inserted back-to-back via defaultNow(), so their real
    // `created_at` carries microsecond residue below the millisecond a JS
    // Date (and thus the encoded cursor) can represent. Without
    // `precision: 3` on campaigns.created_at, the cursor's `eq` branch never
    // matches the row it was built from, the `gt` branch matches instead,
    // and the boundary row is duplicated onto the next page.
    const org = await seedOrganisation(db);
    // seedOrganisation already creates one campaign; add two more so there
    // are 3+ rows to page through.
    const extraIds = [generateId<string>(), generateId<string>()];
    for (const id of extraIds) {
      await db.insert(campaigns).values({
        id,
        organisationId: org.organisationId,
        name: `extra campaign ${id}`,
        brief: "Integration test campaign",
        allowedMarkets: ["crypto"],
        createdByUserId: org.userId,
      });
    }
    const allIds = [org.campaignId, ...extraIds];

    const firstPage = await listCampaigns(db, org.organisationId, { limit: 2 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.page.items).toHaveLength(2);
    expect(firstPage.page.nextCursor).toBeDefined();

    const secondPage = await listCampaigns(db, org.organisationId, { limit: 2, cursor: firstPage.page.nextCursor });
    expect(secondPage.ok).toBe(true);
    if (!secondPage.ok) return;
    expect(secondPage.page.items).toHaveLength(1);
    expect(secondPage.page.nextCursor).toBeUndefined();

    const seenIds = [...firstPage.page.items, ...secondPage.page.items].map((row) => row.id);
    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(seenIds.sort()).toEqual([...allIds].sort());
  });
});
