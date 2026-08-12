import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  closeDatabase,
  createTestDatabase,
  datasetVersions,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  seedStrategyVersion,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { LocalRunnerExecutionJob, routeOutboxEvent } from "@arf-os/event-bus";
import { createBacktestRun, datasetVersionBelongsToOrg } from "./backtest-runs.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("backtest run creation — dataset ownership (integration)", () => {
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

  async function seedDataset(organisationId: string): Promise<string> {
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId,
      objectKey: `key-${artefactId}`,
      contentType: "text/csv",
      sizeBytes: 100,
      checksumSha256: `sum-${artefactId}`,
      kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId,
      symbol: "BTCUSD",
      timeframe: "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-01T14:00:00Z"),
      barCount: 15,
      checksumSha256: `sum-${artefactId}`,
      artefactId,
    });
    return datasetVersionId;
  }

  it("confirms a dataset owned by the caller's organisation", async () => {
    const org = await seedOrganisation(db);
    const datasetVersionId = await seedDataset(org.organisationId);

    expect(await datasetVersionBelongsToOrg(db, org.organisationId, datasetVersionId)).toBe(true);
  });

  it("refuses a dataset that belongs to a different organisation", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const alphaDatasetVersionId = await seedDataset(alpha.organisationId);

    expect(await datasetVersionBelongsToOrg(db, beta.organisationId, alphaDatasetVersionId)).toBe(false);
  });

  it("refuses an unknown dataset version id", async () => {
    const org = await seedOrganisation(db);
    expect(await datasetVersionBelongsToOrg(db, org.organisationId, generateId<string>())).toBe(false);
  });

  it("creates a LOCAL_RUNNER run with its dataset and emits a local-execution outbox event routed to the runner queue", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });
    const datasetVersionId = await seedDataset(org.organisationId);

    const { backtestRunId } = await createBacktestRun(db, {
      strategyVersionId: strategy.strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "local-1",
      datasetVersionId,
      symbol: "BTCUSD",
      timeframe: "1h",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-01T14:00:00Z"),
      costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
      initialCapital: "11000",
      sourceHash: "hash",
      actor: org.userId,
    });

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "backtest_run.local_execution_requested"));
    if (event === undefined) throw new Error("expected a backtest_run.local_execution_requested outbox event");

    expect(event.aggregateId).toBe(backtestRunId);
    expect(event.payload).toEqual({ backtestRunId });
    expect(() => LocalRunnerExecutionJob.parse(event.payload)).not.toThrow();
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      "local-runner-execution",
    );
  });

  it("emits no outbox event for a TRADINGVIEW run", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "TRADINGVIEW_VERIFICATION" });

    await createBacktestRun(db, {
      strategyVersionId: strategy.strategyVersionId,
      runnerType: "TRADINGVIEW",
      runnerVersion: "tv-1",
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: { commissionPct: 0.04 },
      initialCapital: "10000",
      sourceHash: "hash",
      actor: org.userId,
    });

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "backtest_run.local_execution_requested"));
    expect(events).toHaveLength(0);
  });
});
