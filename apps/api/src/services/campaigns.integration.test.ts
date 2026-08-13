import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  committeeDecisions,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  strategies,
  strategyVersions,
  truncateAll,
  type Database,
  type SeededOrganisation,
} from "@arf-os/db";
import { createCampaign, getCampaignSummary, listCampaigns } from "./campaigns.js";

const available = await isTestDatabaseAvailable();

type WorkflowState =
  | "CAMPAIGN_BACKLOG"
  | "IDEA_RESEARCH"
  | "HYPOTHESIS_DRAFT"
  | "PINE_DEVELOPMENT"
  | "TRADINGVIEW_VERIFICATION"
  | "PAPER_APPROVAL_REVIEW"
  | "PAPER_APPROVED"
  | "REJECTED"
  | "BLOCKED";

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

describe.skipIf(!available)("getCampaignSummary (integration)", () => {
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

  async function seedStrategy(org: SeededOrganisation, campaignId: string, workflowState: WorkflowState): Promise<string> {
    const strategyId = generateId<string>();
    const strategyVersionId = generateId<string>();
    await db.insert(strategies).values({ id: strategyId, organisationId: org.organisationId, campaignId, name: "S " + strategyId.slice(0, 6) });
    await db.insert(strategyVersions).values({ id: strategyVersionId, strategyId, parentVersionId: null, versionNumber: 1, workflowState });
    return strategyVersionId;
  }

  it("returns undefined for a campaign that doesn't belong to this organisation", async () => {
    const orgA = await seedOrganisation(db, { slug: "summary-org-a" });
    const orgB = await seedOrganisation(db, { slug: "summary-org-b" });
    expect(await getCampaignSummary(db, orgA.organisationId, orgB.campaignId)).toBeUndefined();
  });

  it("counts strategies by workflow state and backtest runs by status, scoped to one campaign", async () => {
    const org = await seedOrganisation(db, { slug: "summary-counts" });
    const otherCampaign = await createCampaign(db, org.organisationId, org.userId, {
      name: "Other campaign",
      brief: "b",
      allowedMarkets: ["crypto"],
    });

    const svA = await seedStrategy(org, org.campaignId, "PINE_DEVELOPMENT");
    await seedStrategy(org, org.campaignId, "PAPER_APPROVAL_REVIEW");
    await seedStrategy(org, otherCampaign.id, "PINE_DEVELOPMENT"); // must not count

    await db.insert(backtestRuns).values({
      id: generateId<string>(),
      strategyVersionId: svA,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "test",
      symbol: "BTCUSD",
      timeframe: "1h",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-02T00:00:00Z"),
      costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
      initialCapital: "10000",
      sourceHash: "hash",
      status: "SUCCEEDED",
    });

    const summary = await getCampaignSummary(db, org.organisationId, org.campaignId);
    if (!summary) throw new Error("expected a summary");

    expect(summary.strategies).toEqual({ total: 2, byWorkflowState: { PINE_DEVELOPMENT: 1, PAPER_APPROVAL_REVIEW: 1 } });
    expect(summary.backtestRuns).toEqual({ total: 1, byStatus: { SUCCEEDED: 1 } });
    expect(summary.pendingCommitteeDecisions).toBe(1);
  });

  it("derives pendingCommitteeDecisions from the PAPER_APPROVAL_REVIEW count, not a separate query that could drift", async () => {
    const org = await seedOrganisation(db, { slug: "summary-pending" });
    await seedStrategy(org, org.campaignId, "PAPER_APPROVAL_REVIEW");
    await seedStrategy(org, org.campaignId, "PAPER_APPROVAL_REVIEW");
    await seedStrategy(org, org.campaignId, "PINE_DEVELOPMENT");

    const summary = await getCampaignSummary(db, org.organisationId, org.campaignId);
    expect(summary?.pendingCommitteeDecisions).toBe(2);
  });

  it("reports the later of the two activity timestamps: a new version or a new decision", async () => {
    const org = await seedOrganisation(db, { slug: "summary-activity" });
    const strategyId = generateId<string>();
    const svId = generateId<string>();
    await db.insert(strategies).values({ id: strategyId, organisationId: org.organisationId, campaignId: org.campaignId, name: "S" });
    await db.insert(strategyVersions).values({
      id: svId,
      strategyId,
      parentVersionId: null,
      versionNumber: 1,
      workflowState: "PAPER_APPROVAL_REVIEW",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const decisionCreatedAt = new Date("2024-06-01T00:00:00Z");
    await db.insert(committeeDecisions).values({
      id: generateId<string>(),
      strategyVersionId: svId,
      decision: "PAPER_APPROVED",
      reasonCodes: [],
      positiveCase: "positive",
      rejectionCase: "rejection",
      actorId: org.userId,
      createdAt: decisionCreatedAt,
    });

    const summary = await getCampaignSummary(db, org.organisationId, org.campaignId);
    expect(summary?.lastActivityAt?.toISOString()).toBe(decisionCreatedAt.toISOString());
  });

  it("returns a zeroed summary, not an error, for a campaign with no strategies yet", async () => {
    const org = await seedOrganisation(db, { slug: "summary-empty" });
    const summary = await getCampaignSummary(db, org.organisationId, org.campaignId);
    expect(summary).toEqual({
      strategies: { total: 0, byWorkflowState: {} },
      backtestRuns: { total: 0, byStatus: {} },
      pendingCommitteeDecisions: 0,
      lastActivityAt: null,
    });
  });
});
