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
import { listStrategies } from "./strategy-registry.js";

const available = await isTestDatabaseAvailable();

/**
 * `listStrategies`'s per-strategy "latest version + workflow state" lookup
 * (ADR/spec 14.12, docs/architecture.md's "strategy_read_models itself still
 * isn't read by listStrategies"). Distinct from strategy-filters.integration
 * .test.ts, which never seeds a read-model row at all and so only exercises
 * the live fallback — these tests seed the read model directly to prove the
 * fast path is genuinely wired in, not just present and unused.
 */
describe.skipIf(!available)("listStrategies read-model wiring (integration)", () => {
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

  async function seedStrategyWithVersions(
    org: Awaited<ReturnType<typeof seedOrganisation>>,
    name: string,
    versionStates: readonly string[],
  ) {
    const strategyId = generateId<string>();
    await db.insert(strategies).values({ id: strategyId, organisationId: org.organisationId, campaignId: org.campaignId, name });

    const versionIds: string[] = [];
    for (const [index, workflowState] of versionStates.entries()) {
      const versionId = generateId<string>();
      versionIds.push(versionId);
      await db.insert(strategyVersions).values({
        id: versionId,
        strategyId,
        parentVersionId: index === 0 ? null : versionIds[index - 1],
        versionNumber: index + 1,
        workflowState: workflowState as never,
      });
    }
    return { strategyId, versionIds };
  }

  it("trusts the read model's row when one exists, even where it disagrees with the newest live version", async () => {
    const org = await seedOrganisation(db);
    // Two live versions — v1 CAMPAIGN_BACKLOG, v2 PAPER_APPROVED — but the
    // read-model row below deliberately still names v1 as latest, as it
    // would immediately after v2 was created and before the refresh worker
    // (off strategy_version.transitioned) has caught up.
    const { strategyId, versionIds } = await seedStrategyWithVersions(org, "Stale read model", [
      "CAMPAIGN_BACKLOG",
      "PAPER_APPROVED",
    ]);
    const firstVersionId = versionIds[0];
    if (!firstVersionId) throw new Error("expected a seeded version id");

    await db.insert(strategyReadModels).values({
      strategyId,
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      name: "Stale read model",
      latestVersionId: firstVersionId,
      latestVersionNumber: 1,
      workflowState: "CAMPAIGN_BACKLOG",
    });

    const result = await listStrategies(db, org.organisationId, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.page.items.find((row) => row.id === strategyId);
    // The read model's stale value wins — this is what "wired in" means:
    // the read model is the answer, not a hint double-checked against a
    // live query.
    expect(item).toMatchObject({ latestVersionNumber: 1, latestWorkflowState: "CAMPAIGN_BACKLOG" });
  });

  it("falls back to a live lookup for a strategy with no read-model row yet", async () => {
    const org = await seedOrganisation(db);
    // No strategy_read_models row at all — the state of a strategy the
    // moment after createStrategy, before any transition has ever fired.
    const { strategyId, versionIds } = await seedStrategyWithVersions(org, "Brand new", ["CAMPAIGN_BACKLOG"]);

    const result = await listStrategies(db, org.organisationId, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.page.items.find((row) => row.id === strategyId);
    expect(item).toMatchObject({
      latestVersionId: versionIds[0],
      latestVersionNumber: 1,
      latestWorkflowState: "CAMPAIGN_BACKLOG",
    });
  });

  it("resolves a mixed page — one strategy with a read-model row, one without — correctly for both", async () => {
    const org = await seedOrganisation(db);

    const withModel = await seedStrategyWithVersions(org, "Has read model", ["PAPER_APPROVED"]);
    const withModelFirstVersionId = withModel.versionIds[0];
    if (!withModelFirstVersionId) throw new Error("expected a seeded version id");
    await db.insert(strategyReadModels).values({
      strategyId: withModel.strategyId,
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      name: "Has read model",
      latestVersionId: withModelFirstVersionId,
      latestVersionNumber: 1,
      workflowState: "PAPER_APPROVED",
    });

    const withoutModel = await seedStrategyWithVersions(org, "No read model", ["BLOCKED"]);

    const result = await listStrategies(db, org.organisationId, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.items.find((row) => row.id === withModel.strategyId)).toMatchObject({
      latestWorkflowState: "PAPER_APPROVED",
    });
    expect(result.page.items.find((row) => row.id === withoutModel.strategyId)).toMatchObject({
      latestWorkflowState: "BLOCKED",
    });
  });
});
