import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedStrategyVersion,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { getCampaign, listCampaigns } from "./campaigns.js";
import { getStrategyLineage, getStrategyVersion, listStrategies } from "./strategy-registry.js";
import { createTradingViewVerification, getVerification } from "./verification.js";

const available = await isTestDatabaseAvailable();

/**
 * The organisation boundary is the platform's core security property
 * (CLAUDE.md 19.1 — "Verify organisation ownership on every aggregate
 * access"). These tests assert it holds at the database layer, where a
 * missing WHERE clause would otherwise leak another tenant's research.
 */
describe.skipIf(!available)("organisation isolation (integration)", () => {
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

  it("never returns another organisation's campaign by id", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });

    expect(await getCampaign(db, alpha.organisationId, alpha.campaignId)).toBeDefined();
    // Beta knows alpha's campaign id but must still get nothing back.
    expect(await getCampaign(db, beta.organisationId, alpha.campaignId)).toBeUndefined();
  });

  it("scopes campaign listings to the caller's organisation", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    await seedOrganisation(db, { slug: "beta" });

    const result = await listCampaigns(db, alpha.organisationId, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.items[0]?.id).toBe(alpha.campaignId);
    }
  });

  it("never returns another organisation's strategy version by id", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);

    expect(await getStrategyVersion(db, alpha.organisationId, strategy.strategyVersionId)).toBeDefined();
    expect(await getStrategyVersion(db, beta.organisationId, strategy.strategyVersionId)).toBeUndefined();
  });

  it("scopes strategy listings, including when filtered by another org's campaign id", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    await seedStrategyVersion(db, alpha);

    const alphaList = await listStrategies(db, alpha.organisationId, {});
    expect(alphaList.ok && alphaList.page.items).toHaveLength(1);

    // Beta filtering by alpha's campaign must still see nothing: the
    // organisation clause has to win over the caller-supplied filter.
    const betaList = await listStrategies(db, beta.organisationId, { campaignId: alpha.campaignId });
    expect(betaList.ok && betaList.page.items).toHaveLength(0);
  });

  it("returns no lineage for another organisation's strategy version", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);

    expect(await getStrategyLineage(db, beta.organisationId, strategy.strategyVersionId)).toEqual([]);
  });

  it("never returns another organisation's verification, so upload keys cannot be derived", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);

    const { verificationId } = await createTradingViewVerification(db, {
      strategyVersionId: strategy.strategyVersionId,
      requiredSymbol: "BYBIT:BTCUSDT.P",
      requiredTimeframe: "60",
      requestedByUserId: alpha.userId,
    });

    const asAlpha = await getVerification(db, alpha.organisationId, verificationId);
    expect(asAlpha?.organisationId).toBe(alpha.organisationId);
    // This matters beyond reads: the upload route builds its object-store
    // key from this row, so a leak here would cross tenant storage paths.
    expect(await getVerification(db, beta.organisationId, verificationId)).toBeUndefined();
  });
});
