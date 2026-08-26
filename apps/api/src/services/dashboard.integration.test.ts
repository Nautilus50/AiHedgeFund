import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  backtestRuns,
  campaigns,
  closeDatabase,
  createTestDatabase,
  datasetVersions,
  isTestDatabaseAvailable,
  parityReports,
  seedOrganisation,
  strategies,
  strategyDefinitions,
  strategyVersions,
  trades,
  tradingviewVerifications,
  truncateAll,
  type Database,
  type SeededOrganisation,
} from "@arf-os/db";
import { getDashboardKpis } from "./dashboard.js";

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

type BacktestRunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "CANCELLED";

type ParityStatus = "PASS" | "WARN" | "FAIL" | "INSUFFICIENT_DATA";

describe.skipIf(!available)("getDashboardKpis (integration)", () => {
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

  async function seedStrategy(org: SeededOrganisation, workflowState: WorkflowState): Promise<string> {
    const strategyId = generateId<string>();
    const strategyVersionId = generateId<string>();
    await db.insert(strategies).values({ id: strategyId, organisationId: org.organisationId, campaignId: org.campaignId, name: "Strategy " + strategyId.slice(0, 6) });
    await db.insert(strategyVersions).values({ id: strategyVersionId, strategyId, parentVersionId: null, versionNumber: 1, workflowState });
    return strategyVersionId;
  }

  async function seedDataset(org: SeededOrganisation): Promise<void> {
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId, organisationId: org.organisationId, objectKey: "test/" + datasetVersionId + ".csv",
      contentType: "text/csv", sizeBytes: 10, checksumSha256: "deadbeef", kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId, organisationId: org.organisationId, symbol: "BTCUSD", timeframe: "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      barCount: 24, checksumSha256: "deadbeef", artefactId,
    });
  }

  async function seedBacktestRun(
    strategyVersionId: string,
    input: {
      status: BacktestRunStatus;
      runnerType: "LOCAL_RUNNER" | "TRADINGVIEW";
      parityStatus?: ParityStatus;
      requestedByUserId?: string;
    },
  ): Promise<void> {
    let verificationId: string | undefined;
    if (input.parityStatus) {
      verificationId = generateId<string>();
      await db.insert(tradingviewVerifications).values({
        id: verificationId, strategyVersionId, requiredSymbol: "BTCUSD", requiredTimeframe: "1h",
        requestedByUserId: input.requestedByUserId ?? generateId<string>(),
      });
    }

    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId, strategyVersionId, runnerType: input.runnerType, runnerVersion: "test",
      verificationId, symbol: "BTCUSD", timeframe: "1h", segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
      initialCapital: "10000", sourceHash: "hash", status: input.status,
    });

    if (input.parityStatus && verificationId) {
      await db.insert(parityReports).values({
        id: generateId<string>(), backtestRunId, verificationId, status: input.parityStatus, comparison: {},
      });
    }
  }

  it("counts campaigns, strategies by state, backtest runs by status/runner, datasets, and parity — all correctly grouped", async () => {
    const org = await seedOrganisation(db, { slug: "kpi-org" });

    // seedOrganisation already creates 1 campaign; add a second.
    await db.insert(campaigns).values({
      id: generateId<string>(), organisationId: org.organisationId, name: "Second campaign",
      brief: "Integration test", allowedMarkets: ["crypto"], createdByUserId: org.userId,
    });

    const svA = await seedStrategy(org, "PINE_DEVELOPMENT");
    const svB = await seedStrategy(org, "PINE_DEVELOPMENT");
    await seedStrategy(org, "CAMPAIGN_BACKLOG");

    await seedDataset(org);
    await seedDataset(org);

    await seedBacktestRun(svA, { status: "SUCCEEDED", runnerType: "LOCAL_RUNNER" });
    await seedBacktestRun(svA, { status: "FAILED_TERMINAL", runnerType: "LOCAL_RUNNER" });
    await seedBacktestRun(svB, { status: "SUCCEEDED", runnerType: "TRADINGVIEW", parityStatus: "PASS", requestedByUserId: org.userId });

    const kpis = await getDashboardKpis(db, org.organisationId);

    expect(kpis.campaigns.total).toBe(2);

    expect(kpis.strategies.total).toBe(3);
    expect(kpis.strategies.byWorkflowState).toEqual({ PINE_DEVELOPMENT: 2, CAMPAIGN_BACKLOG: 1 });

    expect(kpis.backtestRuns.total).toBe(3);
    expect(kpis.backtestRuns.byStatus).toEqual({ SUCCEEDED: 2, FAILED_TERMINAL: 1 });
    expect(kpis.backtestRuns.byRunnerType).toEqual({ LOCAL_RUNNER: 2, TRADINGVIEW: 1 });

    expect(kpis.datasets.total).toBe(2);

    expect(kpis.parity.total).toBe(1);
    expect(kpis.parity.byStatus).toEqual({ PASS: 1 });
  });

  it("returns all-zero KPIs for an organisation with no data, not an error", async () => {
    const org = await seedOrganisation(db, { slug: "kpi-empty" });
    const kpis = await getDashboardKpis(db, org.organisationId);

    expect(kpis.campaigns.total).toBe(1); // seedOrganisation's own campaign
    expect(kpis.strategies).toEqual({ total: 0, byWorkflowState: {} });
    expect(kpis.backtestRuns).toEqual({ total: 0, byStatus: {}, byRunnerType: {} });
    expect(kpis.datasets.total).toBe(0);
    expect(kpis.parity).toEqual({ total: 0, byStatus: {} });
    expect(kpis.portfolioResearch).toEqual({ paperApprovedStrategies: 0, withSdlDefinition: 0 });
    expect(kpis.validationLab).toEqual({ withBenchmarkDataset: 0, withClosedTrades: 0 });
  });

  it("never counts another organisation's data", async () => {
    const orgA = await seedOrganisation(db, { slug: "kpi-iso-a" });
    const orgB = await seedOrganisation(db, { slug: "kpi-iso-b" });

    const svA = await seedStrategy(orgA, "PINE_DEVELOPMENT");
    await seedStrategy(orgB, "PINE_DEVELOPMENT");
    await seedStrategy(orgB, "PINE_DEVELOPMENT");

    await seedDataset(orgB);
    await seedBacktestRun(svA, { status: "SUCCEEDED", runnerType: "LOCAL_RUNNER" });

    const kpisA = await getDashboardKpis(db, orgA.organisationId);
    expect(kpisA.strategies.total).toBe(1);
    expect(kpisA.datasets.total).toBe(0);
    expect(kpisA.backtestRuns.total).toBe(1);

    const kpisB = await getDashboardKpis(db, orgB.organisationId);
    expect(kpisB.strategies.total).toBe(2);
    expect(kpisB.datasets.total).toBe(1);
    expect(kpisB.backtestRuns.total).toBe(0);
  });

  it("counts PAPER_APPROVED strategies and how many have an SDL definition on their latest version", async () => {
    const org = await seedOrganisation(db, { slug: "kpi-signal-overlap" });

    const withDefinition = await seedStrategy(org, "PAPER_APPROVED");
    await db.insert(strategyDefinitions).values({
      id: generateId<string>(),
      strategyVersionId: withDefinition,
      definition: { signals: { longEntry: "a", shortEntry: "b" } },
      definitionHash: "hash",
    });

    await seedStrategy(org, "PAPER_APPROVED"); // no definition row
    await seedStrategy(org, "PINE_DEVELOPMENT"); // not PAPER_APPROVED — excluded entirely

    const kpis = await getDashboardKpis(db, org.organisationId);
    expect(kpis.portfolioResearch).toEqual({ paperApprovedStrategies: 2, withSdlDefinition: 1 });
  });

  it("counts backtest runs with a linked dataset and with at least one closed trade", async () => {
    const org = await seedOrganisation(db, { slug: "kpi-validation-lab" });
    const strategyVersionId = await seedStrategy(org, "PAPER_APPROVED");

    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId, organisationId: org.organisationId, objectKey: `test/${datasetVersionId}.csv`,
      contentType: "text/csv", sizeBytes: 10, checksumSha256: "deadbeef", kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId, organisationId: org.organisationId, symbol: "BTCUSD", timeframe: "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      barCount: 24, checksumSha256: "deadbeef", artefactId,
    });

    const withDatasetRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: withDatasetRunId, strategyVersionId, runnerType: "LOCAL_RUNNER", runnerVersion: "test",
      datasetVersionId, symbol: "BTCUSD", timeframe: "1h", segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      costModel: {}, initialCapital: "10000", sourceHash: "hash", status: "SUCCEEDED",
    });

    const withClosedTradeRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: withClosedTradeRunId, strategyVersionId, runnerType: "LOCAL_RUNNER", runnerVersion: "test",
      symbol: "BTCUSD", timeframe: "1h", segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      costModel: {}, initialCapital: "10000", sourceHash: "hash", status: "SUCCEEDED",
    });
    await db.insert(trades).values({
      id: generateId<string>(), backtestRunId: withClosedTradeRunId, sequenceNumber: 1, direction: "LONG",
      entryTime: new Date("2024-01-01T00:00:00Z"), exitTime: new Date("2024-01-01T01:00:00Z"),
      entryPrice: "100", exitPrice: "101", quantity: "1", netPnl: "1",
    });

    // A third run with neither a dataset nor a closed trade — must not be counted in either bucket.
    await db.insert(backtestRuns).values({
      id: generateId<string>(), strategyVersionId, runnerType: "LOCAL_RUNNER", runnerVersion: "test",
      symbol: "BTCUSD", timeframe: "1h", segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
      costModel: {}, initialCapital: "10000", sourceHash: "hash", status: "QUEUED",
    });

    const kpis = await getDashboardKpis(db, org.organisationId);
    expect(kpis.validationLab).toEqual({ withBenchmarkDataset: 1, withClosedTrades: 1 });
  });
});
