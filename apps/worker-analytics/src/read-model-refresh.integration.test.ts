import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  closeDatabase,
  committeeDecisions,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedStrategyVersion,
  strategyReadModels,
  strategyVersions,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { handleReadModelRefresh } from "./handlers.js";

const available = await isTestDatabaseAvailable();

/**
 * `handleReadModelRefresh` always recomputes the strategy's read-model row
 * from the canonical tables rather than applying the triggering event as a
 * delta — these tests exercise that "refresh, don't patch" contract
 * directly, since it's the property the whole design depends on.
 */
describe.skipIf(!available)("read model refresh", () => {
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

  async function readRow(strategyId: string) {
    const [row] = await db.select().from(strategyReadModels).where(eq(strategyReadModels.strategyId, strategyId));
    return row;
  }

  it("computes the row from a strategy's only version, with no decision yet", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    const result = await handleReadModelRefresh(db, {
      organisationId: org.organisationId,
      aggregateType: "strategy_version",
      aggregateId: strategy.strategyVersionId,
    });

    expect(result).toEqual({
      strategyId: strategy.strategyId,
      workflowState: "PINE_DEVELOPMENT",
      latestDecision: null,
    });

    const row = await readRow(strategy.strategyId);
    expect(row?.organisationId).toBe(org.organisationId);
    expect(row?.campaignId).toBe(org.campaignId);
    expect(row?.latestVersionId).toBe(strategy.strategyVersionId);
    expect(row?.latestVersionNumber).toBe(1);
    expect(row?.latestDecisionAt).toBeNull();
  });

  it("reflects the strategy's current latest version, even when triggered by an older version's event", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    const versionTwoId = generateId<string>();
    await db.insert(strategyVersions).values({
      id: versionTwoId,
      strategyId: strategy.strategyId,
      parentVersionId: strategy.strategyVersionId,
      versionNumber: 2,
      workflowState: "TRADINGVIEW_VERIFICATION",
    });

    // Triggered by the OLDER version's id — a delta-applying implementation
    // would wrongly write version 1's state. This must resolve to version 2.
    const result = await handleReadModelRefresh(db, {
      organisationId: org.organisationId,
      aggregateType: "strategy_version",
      aggregateId: strategy.strategyVersionId,
    });

    expect(result.workflowState).toBe("TRADINGVIEW_VERIFICATION");
    const row = await readRow(strategy.strategyId);
    expect(row?.latestVersionId).toBe(versionTwoId);
    expect(row?.latestVersionNumber).toBe(2);
  });

  it("includes the strategy's latest committee decision", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVAL_REVIEW" });
    const actorId = generateId<string>();

    await db.insert(committeeDecisions).values({
      id: generateId<string>(),
      strategyVersionId: strategy.strategyVersionId,
      decision: "PAPER_APPROVED",
      reasonCodes: ["STRONG_EDGE"],
      rejectionCase: "n/a",
      positiveCase: "Consistent edge across segments.",
      conditions: [],
      requiredNextEvidence: [],
      actorId,
      humanOverride: false,
    });

    const result = await handleReadModelRefresh(db, {
      organisationId: org.organisationId,
      aggregateType: "strategy_version",
      aggregateId: strategy.strategyVersionId,
    });

    expect(result.latestDecision).toBe("PAPER_APPROVED");
    const row = await readRow(strategy.strategyId);
    expect(row?.latestDecision).toBe("PAPER_APPROVED");
    expect(row?.latestDecisionActorId).toBe(actorId);
    expect(row?.latestDecisionAt).not.toBeNull();
  });

  it("replaces rather than duplicates the row when replayed", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    const input = { organisationId: org.organisationId, aggregateType: "strategy_version" as const, aggregateId: strategy.strategyVersionId };
    await handleReadModelRefresh(db, input);
    await handleReadModelRefresh(db, input);

    const rows = await db.select().from(strategyReadModels).where(eq(strategyReadModels.strategyId, strategy.strategyId));
    expect(rows).toHaveLength(1);
  });

  it("refuses an unrecognised aggregateType rather than silently no-op'ing", async () => {
    const org = await seedOrganisation(db);

    await expect(
      handleReadModelRefresh(db, {
        organisationId: org.organisationId,
        aggregateType: "committee_decision",
        aggregateId: generateId<string>(),
      }),
    ).rejects.toThrow(/Unrecognised read-model aggregateType/);
  });

  it("refuses an unknown strategy version", async () => {
    const org = await seedOrganisation(db);

    await expect(
      handleReadModelRefresh(db, {
        organisationId: org.organisationId,
        aggregateType: "strategy_version",
        aggregateId: generateId<string>(),
      }),
    ).rejects.toThrow(/not found/);
  });
});
