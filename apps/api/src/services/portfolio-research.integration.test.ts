import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { backtestRuns, closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, seedStrategyVersion, truncateAll, type Database } from "@arf-os/db";
import { getPortfolioCorrelationReport } from "./portfolio-research.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("portfolio research (integration)", () => {
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

  async function seedSucceededRun(strategyVersionId: string, input: { segmentKind: string; symbol?: string }): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "local-1",
      symbol: input.symbol ?? "BTCUSD",
      timeframe: "1h",
      segmentKind: input.segmentKind,
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
      initialCapital: "10000",
      status: "SUCCEEDED",
      sourceHash: "hash",
    });
    return backtestRunId;
  }

  async function seedQueuedRun(strategyVersionId: string): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "local-1",
      symbol: "BTCUSD",
      timeframe: "1h",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: {},
      initialCapital: "10000",
      status: "QUEUED",
      sourceHash: "hash",
    });
    return backtestRunId;
  }

  it("never returns another organisation's strategies, and the strategyVersionIds filter never leaks one in either", async () => {
    const orgA = await seedOrganisation(db, { slug: "portfolio-org-a" });
    const orgB = await seedOrganisation(db, { slug: "portfolio-org-b" });

    const stratA = await seedStrategyVersion(db, orgA, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratA.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const stratB = await seedStrategyVersion(db, orgB, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratB.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const reportUnfiltered = await getPortfolioCorrelationReport(db, orgA.organisationId, {});
    expect(reportUnfiltered.strategies.map((s) => s.strategyId)).toEqual([stratA.strategyId]);

    // Explicitly asking for org B's strategy version while authenticated as org A must not leak it in.
    const reportFiltered = await getPortfolioCorrelationReport(db, orgA.organisationId, {
      strategyVersionIds: [stratB.strategyVersionId],
    });
    expect(reportFiltered.strategies).toEqual([]);
  });

  it("prefers OUT_OF_SAMPLE over IN_SAMPLE when both exist for the same strategy", async () => {
    const org = await seedOrganisation(db);
    const strat = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(strat.strategyVersionId, { segmentKind: "IN_SAMPLE" });
    const oosRunId = await seedSucceededRun(strat.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.strategies).toHaveLength(1);
    expect(report.strategies[0]).toMatchObject({ backtestRunId: oosRunId, segmentKind: "OUT_OF_SAMPLE" });
  });

  it("sets evidenceTierMismatch when the two strategies' representative runs differ in segment kind", async () => {
    const org = await seedOrganisation(db);
    const stratA = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratA.strategyVersionId, { segmentKind: "IN_SAMPLE" });
    const stratB = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratB.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.pairCorrelations).toHaveLength(1);
    expect(report.pairCorrelations[0]?.evidenceTierMismatch).toBe(true);
  });

  it("does not set evidenceTierMismatch when both representative runs share a segment kind", async () => {
    const org = await seedOrganisation(db);
    const stratA = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratA.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });
    const stratB = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratB.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.pairCorrelations[0]?.evidenceTierMismatch).toBe(false);
  });

  it("excludes a PAPER_APPROVED strategy with no SUCCEEDED run, rather than zero-filling it", async () => {
    const org = await seedOrganisation(db);
    const strat = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedQueuedRun(strat.strategyVersionId);

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.strategies).toEqual([]);
    expect(report.excludedStrategies).toEqual([{ strategyId: strat.strategyId, strategyName: "Integration test strategy", reasonCode: "NO_SUCCEEDED_RUN" }]);
  });

  it("never includes a non-PAPER_APPROVED strategy", async () => {
    const org = await seedOrganisation(db);
    const strat = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });
    await seedSucceededRun(strat.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE" });

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.strategies).toEqual([]);
    expect(report.excludedStrategies).toEqual([]);
  });

  it("groups market concentration by the representative run's symbol", async () => {
    const org = await seedOrganisation(db);
    const stratA = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratA.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", symbol: "BTCUSD" });
    const stratB = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedSucceededRun(stratB.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", symbol: "BTCUSD" });

    const report = await getPortfolioCorrelationReport(db, org.organisationId, {});
    expect(report.marketConcentration).toEqual([{ symbol: "BTCUSD", count: 2 }]);
  });
});
