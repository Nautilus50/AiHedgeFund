import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  strategies,
  strategyReadModels,
  strategyVersions,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { createCampaign } from "./campaigns.js";
import { listCommitteeQueue } from "./committee-queue.js";

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

describe.skipIf(!available)("listCommitteeQueue (integration)", () => {
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

  // strategy_read_models has real FKs to strategies/strategy_versions —
  // this seeds those backing rows too, matching what handleReadModelRefresh
  // would actually be recomputing from, not just the projection in isolation.
  async function seedReadModel(
    organisationId: string,
    campaignId: string,
    workflowState: WorkflowState,
    refreshedAt: Date,
  ): Promise<string> {
    const strategyId = generateId<string>();
    const versionId = generateId<string>();
    const name = "Strategy " + strategyId.slice(0, 6);

    await db.insert(strategies).values({ id: strategyId, organisationId, campaignId, name });
    await db.insert(strategyVersions).values({ id: versionId, strategyId, parentVersionId: null, versionNumber: 1, workflowState });
    await db.insert(strategyReadModels).values({
      strategyId,
      organisationId,
      campaignId,
      name,
      latestVersionId: versionId,
      latestVersionNumber: 1,
      workflowState,
      refreshedAt,
    });
    return strategyId;
  }

  it("lists only strategies whose latest version is PAPER_APPROVAL_REVIEW", async () => {
    const org = await seedOrganisation(db);
    const waiting = await seedReadModel(org.organisationId, org.campaignId, "PAPER_APPROVAL_REVIEW", new Date());
    await seedReadModel(org.organisationId, org.campaignId, "PINE_DEVELOPMENT", new Date());
    await seedReadModel(org.organisationId, org.campaignId, "PAPER_APPROVED", new Date());

    const items = await listCommitteeQueue(db, org.organisationId);
    expect(items.map((i) => i.strategyId)).toEqual([waiting]);
  });

  it("never returns another organisation's queue items", async () => {
    const orgA = await seedOrganisation(db, { slug: "queue-org-a" });
    const orgB = await seedOrganisation(db, { slug: "queue-org-b" });
    await seedReadModel(orgB.organisationId, orgB.campaignId, "PAPER_APPROVAL_REVIEW", new Date());

    const items = await listCommitteeQueue(db, orgA.organisationId);
    expect(items).toEqual([]);
  });

  it("narrows to one campaign when campaignId is given", async () => {
    const org = await seedOrganisation(db, { slug: "queue-narrow" });
    const otherCampaign = await createCampaign(db, org.organisationId, org.userId, {
      name: "Other campaign",
      brief: "b",
      allowedMarkets: ["crypto"],
    });
    const inCampaign = await seedReadModel(org.organisationId, org.campaignId, "PAPER_APPROVAL_REVIEW", new Date());
    await seedReadModel(org.organisationId, otherCampaign.id, "PAPER_APPROVAL_REVIEW", new Date());

    const items = await listCommitteeQueue(db, org.organisationId, org.campaignId);
    expect(items.map((i) => i.strategyId)).toEqual([inCampaign]);
  });

  it("orders oldest-waiting first", async () => {
    const org = await seedOrganisation(db, { slug: "queue-order" });
    const newer = await seedReadModel(org.organisationId, org.campaignId, "PAPER_APPROVAL_REVIEW", new Date("2024-06-01T00:00:00Z"));
    const older = await seedReadModel(org.organisationId, org.campaignId, "PAPER_APPROVAL_REVIEW", new Date("2024-01-01T00:00:00Z"));

    const items = await listCommitteeQueue(db, org.organisationId);
    expect(items.map((i) => i.strategyId)).toEqual([older, newer]);
  });

  it("returns an empty list, not an error, when nothing is waiting", async () => {
    const org = await seedOrganisation(db, { slug: "queue-empty" });
    expect(await listCommitteeQueue(db, org.organisationId)).toEqual([]);
  });
});
