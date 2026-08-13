import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, truncateAll, type Database } from "@arf-os/db";
import { createCampaign, listCampaigns } from "./campaigns.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("campaigns (integration)", () => {
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

  it("never lists another organisation's campaigns", async () => {
    // seedOrganisation already creates one campaign of its own per org
    // (fixtures.ts) — both orgs start with that plus the one explicitly
    // created here.
    const orgA = await seedOrganisation(db, { slug: "campaigns-org-a" });
    const orgB = await seedOrganisation(db, { slug: "campaigns-org-b" });

    const owned = await createCampaign(db, orgA.organisationId, orgA.userId, {
      name: "Alpha campaign",
      brief: "Test brief",
      allowedMarkets: ["crypto"],
    });
    await createCampaign(db, orgB.organisationId, orgB.userId, {
      name: "Beta campaign",
      brief: "Test brief",
      allowedMarkets: ["crypto"],
    });

    const result = await listCampaigns(db, orgA.organisationId, {});
    if (!result.ok) throw new Error("expected ok result");
    expect(result.page.items).toHaveLength(2);
    expect(result.page.items.map((c) => c.id)).toEqual(expect.arrayContaining([owned.id, orgA.campaignId]));
    expect(result.page.items.every((c) => c.organisationId === orgA.organisationId)).toBe(true);
  });

  it("rejects a malformed cursor rather than silently ignoring it", async () => {
    const org = await seedOrganisation(db);
    const result = await listCampaigns(db, org.organisationId, { cursor: "not-a-real-cursor" });
    expect(result).toEqual({ ok: false, reasonCode: "INVALID_CURSOR" });
  });

  /**
   * Regression test for the cursor-pagination precision bug (see
   * packages/db/src/schema/campaigns.ts's `created_at` comment, and its
   * sibling fix for dataset_versions.created_at): without `precision: 3`
   * on the column, a row whose real timestamp has nonzero sub-millisecond
   * digits spuriously re-matches its own millisecond-truncated cursor on
   * the next page. Walks every page rather than checking one page's shape,
   * so a duplicated or skipped row anywhere in the sequence is caught.
   */
  it("never duplicates or skips a row across a full pagination walk", async () => {
    const org = await seedOrganisation(db);
    // seedOrganisation's own auto-created campaign is part of the set too.
    const created: string[] = [org.campaignId];
    for (let i = 0; i < 11; i++) {
      const campaign = await createCampaign(db, org.organisationId, org.userId, {
        name: `Campaign ${i}`,
        brief: "Test brief",
        allowedMarkets: ["crypto"],
      });
      created.push(campaign.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await listCampaigns(db, org.organisationId, { cursor, limit: 3 });
      if (!result.ok) throw new Error("expected ok result");
      seen.push(...result.page.items.map((c) => c.id));
      if (!result.page.nextCursor) break;
      cursor = result.page.nextCursor;
    }

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect(new Set(seen)).toEqual(new Set(created));
  });
});
