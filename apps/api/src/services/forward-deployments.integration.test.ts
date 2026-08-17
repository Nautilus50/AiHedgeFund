import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  forwardDeployments,
  forwardDrawdownPoints,
  healthSnapshots,
  isTestDatabaseAvailable,
  paperFills,
  paperOrders,
  seedOrganisation,
  seedStrategyVersion,
  signalEvents,
  strategyVersions,
  trades,
  truncateAll,
  type Database,
} from "@arf-os/db";
import {
  completeForwardDeployment,
  createForwardDeployment,
  getForwardDeployment,
  getForwardDeploymentHealth,
  getForwardDriftReport,
  getHealthSnapshots,
  pauseForwardDeployment,
  resumeForwardDeployment,
  sweepHealthSnapshots,
} from "./forward-deployments.js";

const available = await isTestDatabaseAvailable();

function fillModel() {
  return {
    fillModelVersion: "1.0.0",
    latencyModel: { type: "fixed_seconds" as const, seconds: 0 },
    slippageModel: { type: "fixed_percent" as const, value: 0 },
    commissionModel: { type: "percent" as const, value: 0 },
    quantityModel: { type: "percent_of_equity" as const, percent: 10 },
    stopTargetRule: { type: "external_alert_only" as const },
  };
}

describe.skipIf(!available)("forward deployments (integration)", () => {
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

  it("refuses a deployment for a strategy version that isn't PAPER_APPROVED", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "TRADINGVIEW_VERIFICATION" });

    const result = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });

    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_PAPER_APPROVED" });
  });

  it("creates an ACTIVE deployment for a PAPER_APPROVED version, persisting only the token's hash", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });

    const result = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.length).toBeGreaterThan(20);

    const [row] = await db.select().from(forwardDeployments).where(eq(forwardDeployments.id, result.deploymentId));
    expect(row?.state).toBe("ACTIVE");
    expect(row?.deploymentTokenHash).not.toBe(result.token);
    expect(row?.activatedAt).not.toBeNull();
  });

  it("never returns another organisation's deployment", async () => {
    const orgA = await seedOrganisation(db, { slug: "forward-org-a" });
    const orgB = await seedOrganisation(db, { slug: "forward-org-b" });
    const strategy = await seedStrategyVersion(db, orgA, { workflowState: "PAPER_APPROVED" });

    const created = await createForwardDeployment(db, orgA.organisationId, orgA.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");

    expect(await getForwardDeployment(db, orgB.organisationId, created.deploymentId)).toBeUndefined();
    expect(await getForwardDeployment(db, orgA.organisationId, created.deploymentId)).toBeDefined();
  });

  it("flags when a newer PAPER_APPROVED sibling version exists (CLAUDE.md 3.4)", async () => {
    const org = await seedOrganisation(db);
    const v1 = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });

    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: v1.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");

    const before = await getForwardDeployment(db, org.organisationId, created.deploymentId);
    expect(before?.newerApprovedVersionExists).toBe(false);

    // A second, newer PAPER_APPROVED version of the SAME strategy.
    await db.insert(strategyVersions).values({
      id: generateId<string>(),
      strategyId: v1.strategyId,
      parentVersionId: v1.strategyVersionId,
      versionNumber: 2,
      workflowState: "PAPER_APPROVED",
    });

    const after = await getForwardDeployment(db, org.organisationId, created.deploymentId);
    expect(after?.newerApprovedVersionExists).toBe(true);
  });

  async function seedActiveDeployment(): Promise<{ organisationId: string; deploymentId: string }> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");
    return { organisationId: org.organisationId, deploymentId: created.deploymentId };
  }

  it("pauses an ACTIVE deployment, resumes it, then completes it", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const paused = await pauseForwardDeployment(db, organisationId, deploymentId);
    expect(paused.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("PAUSED");

    const resumed = await resumeForwardDeployment(db, organisationId, deploymentId);
    expect(resumed.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("ACTIVE");

    const completed = await completeForwardDeployment(db, organisationId, deploymentId);
    expect(completed.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("COMPLETED");
  });

  it("refuses to pause a deployment that is not ACTIVE", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();
    await pauseForwardDeployment(db, organisationId, deploymentId);

    const result = await pauseForwardDeployment(db, organisationId, deploymentId);
    expect(result).toMatchObject({ ok: false, reasonCode: "INVALID_STATE" });
  });

  it("refuses a transition on an unknown deployment", async () => {
    const org = await seedOrganisation(db);
    const result = await pauseForwardDeployment(db, org.organisationId, generateId<string>());
    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
  });

  it("computes health as HEALTHY with no signals yet, and NOT_CONFIGURED for strategy performance without a threshold", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const health = await getForwardDeploymentHealth(db, organisationId, deploymentId);
    expect(health).toEqual({
      deploymentState: "ACTIVE",
      infrastructureHealth: "HEALTHY",
      infrastructureReasons: [],
      strategyPerformanceHealth: "NOT_CONFIGURED",
    });
  });

  it("flags infrastructureHealth DEGRADED when most recent signals were rejected", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    for (let i = 0; i < 3; i++) {
      await db.insert(signalEvents).values({
        id: generateId<string>(),
        deploymentId,
        idempotencyKey: generateId<string>(),
        eventType: "ENTRY_LONG",
        direction: "LONG",
        rawPayload: {},
        processingStatus: "REJECTED",
        rejectionReason: "SYMBOL_MISMATCH",
      });
    }
    await db.insert(signalEvents).values({
      id: generateId<string>(),
      deploymentId,
      idempotencyKey: generateId<string>(),
      eventType: "ENTRY_LONG",
      direction: "LONG",
      rawPayload: {},
      processingStatus: "PROCESSED",
    });

    const health = await getForwardDeploymentHealth(db, organisationId, deploymentId);
    expect(health?.infrastructureHealth).toBe("DEGRADED");
    expect(health?.infrastructureReasons).toContain("SYMBOL_MISMATCH");
  });

  it("flags strategyPerformanceHealth DRAWDOWN_ALERT once realised drawdown crosses the configured threshold", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
      maxDrawdownPctAlertThreshold: 5,
    });
    if (!created.ok) throw new Error("unreachable");

    await db.insert(forwardDrawdownPoints).values({
      id: generateId<string>(),
      deploymentId: created.deploymentId,
      sequenceNumber: 1,
      barTime: new Date(),
      drawdown: "1000",
      drawdownPct: "10",
    });

    const health = await getForwardDeploymentHealth(db, org.organisationId, created.deploymentId);
    expect(health?.strategyPerformanceHealth).toBe("DRAWDOWN_ALERT");
  });

  it("sweepHealthSnapshots writes one row per ACTIVE deployment, and a re-run with the same tickAt is a no-op", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();
    const tickAt = new Date("2026-01-01T00:00:00Z");

    const first = await sweepHealthSnapshots(db, organisationId, tickAt, false);
    expect(first).toEqual([{ deploymentId, skippedExisting: false }]);

    const second = await sweepHealthSnapshots(db, organisationId, tickAt, false);
    expect(second).toEqual([{ deploymentId, skippedExisting: true }]);

    const rows = await db.select().from(healthSnapshots).where(eq(healthSnapshots.deploymentId, deploymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.infrastructureHealth).toBe("HEALTHY");
  });

  it("dry-run reports what sweepHealthSnapshots would do without writing anything", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const result = await sweepHealthSnapshots(db, organisationId, new Date(), true);
    expect(result).toEqual([{ deploymentId, skippedExisting: false }]);
    expect(await db.select().from(healthSnapshots)).toHaveLength(0);
  });

  it("never returns another organisation's health snapshots", async () => {
    const orgA = await seedOrganisation(db, { slug: "health-snap-org-a" });
    const orgB = await seedOrganisation(db, { slug: "health-snap-org-b" });
    const strategyA = await seedStrategyVersion(db, orgA, { workflowState: "PAPER_APPROVED" });
    const createdA = await createForwardDeployment(db, orgA.organisationId, orgA.userId, {
      strategyVersionId: strategyA.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!createdA.ok) throw new Error("unreachable");
    await sweepHealthSnapshots(db, orgA.organisationId, new Date(), false);

    expect(await getHealthSnapshots(db, orgB.organisationId, createdA.deploymentId)).toBeUndefined();
    const ownRead = await getHealthSnapshots(db, orgA.organisationId, createdA.deploymentId);
    expect(ownRead).toHaveLength(1);
  });

  it("drift report: NO_BASELINE_RUN when the strategy version has no SUCCEEDED backtest run", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const report = await getForwardDriftReport(db, organisationId, deploymentId);
    expect(report).toMatchObject({ baseline: undefined, reasonCode: "NO_BASELINE_RUN" });
  });

  async function seedBaselineRun(strategyVersionId: string): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "local-1",
      symbol: "BTCUSD",
      timeframe: "1h",
      segmentKind: "OUT_OF_SAMPLE",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
      initialCapital: "10000",
      status: "SUCCEEDED",
      sourceHash: "hash",
    });
    return backtestRunId;
  }

  it("drift report: INSUFFICIENT_FORWARD_TRADES below the 5-trade floor", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");
    await seedBaselineRun(strategy.strategyVersionId);

    // Only 2 closed round trips — below MIN_FORWARD_TRADES_FOR_DRIFT (5).
    for (let i = 0; i < 2; i++) {
      const entrySignal = generateId<string>();
      const exitSignal = generateId<string>();
      await db.insert(signalEvents).values([
        { id: entrySignal, deploymentId: created.deploymentId, idempotencyKey: generateId<string>(), eventType: "ENTRY_LONG", rawPayload: {} },
        { id: exitSignal, deploymentId: created.deploymentId, idempotencyKey: generateId<string>(), eventType: "EXIT_LONG", rawPayload: {} },
      ]);
      const entryOrder = generateId<string>();
      const exitOrder = generateId<string>();
      await db.insert(paperOrders).values([
        { id: entryOrder, deploymentId: created.deploymentId, signalEventId: entrySignal, direction: "LONG", role: "ENTRY", requestedPrice: "100", quantity: "1" },
        { id: exitOrder, deploymentId: created.deploymentId, signalEventId: exitSignal, direction: "LONG", role: "EXIT", requestedPrice: "110", quantity: "1" },
      ]);
      await db.insert(paperFills).values([
        { id: generateId<string>(), paperOrderId: entryOrder, deploymentId: created.deploymentId, sequenceNumber: i * 2 + 1, filledPrice: "100", filledAt: new Date() },
        { id: generateId<string>(), paperOrderId: exitOrder, deploymentId: created.deploymentId, sequenceNumber: i * 2 + 2, filledPrice: "110", filledAt: new Date() },
      ]);
    }

    const report = await getForwardDriftReport(db, org.organisationId, created.deploymentId);
    expect(report).toMatchObject({ reasonCode: "INSUFFICIENT_FORWARD_TRADES", closedForwardTradeCount: 2 });
  });

  it("drift report: computes degradation against the baseline once 5+ forward trades have closed", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");
    const baselineRunId = await seedBaselineRun(strategy.strategyVersionId);

    // Baseline: 2 winners, 0 losers — 100% win rate, hand-calculable.
    await db.insert(trades).values([
      {
        id: generateId<string>(),
        backtestRunId: baselineRunId,
        sequenceNumber: 1,
        direction: "LONG",
        entryTime: new Date("2024-01-01T00:00:00Z"),
        exitTime: new Date("2024-01-01T01:00:00Z"),
        entryPrice: "100",
        exitPrice: "110",
        quantity: "1",
        netPnl: "10",
      },
      {
        id: generateId<string>(),
        backtestRunId: baselineRunId,
        sequenceNumber: 2,
        direction: "LONG",
        entryTime: new Date("2024-01-02T00:00:00Z"),
        exitTime: new Date("2024-01-02T01:00:00Z"),
        entryPrice: "100",
        exitPrice: "110",
        quantity: "1",
        netPnl: "10",
      },
    ]);

    // Forward: 5 closed round trips, all winners at $10 net each — same win rate as baseline (0% degradation).
    for (let i = 0; i < 5; i++) {
      const entrySignal = generateId<string>();
      const exitSignal = generateId<string>();
      await db.insert(signalEvents).values([
        { id: entrySignal, deploymentId: created.deploymentId, idempotencyKey: generateId<string>(), eventType: "ENTRY_LONG", rawPayload: {} },
        { id: exitSignal, deploymentId: created.deploymentId, idempotencyKey: generateId<string>(), eventType: "EXIT_LONG", rawPayload: {} },
      ]);
      const entryOrder = generateId<string>();
      const exitOrder = generateId<string>();
      await db.insert(paperOrders).values([
        { id: entryOrder, deploymentId: created.deploymentId, signalEventId: entrySignal, direction: "LONG", role: "ENTRY", requestedPrice: "100", quantity: "1" },
        { id: exitOrder, deploymentId: created.deploymentId, signalEventId: exitSignal, direction: "LONG", role: "EXIT", requestedPrice: "110", quantity: "1" },
      ]);
      await db.insert(paperFills).values([
        { id: generateId<string>(), paperOrderId: entryOrder, deploymentId: created.deploymentId, sequenceNumber: i * 2 + 1, filledPrice: "100", filledAt: new Date() },
        { id: generateId<string>(), paperOrderId: exitOrder, deploymentId: created.deploymentId, sequenceNumber: i * 2 + 2, filledPrice: "110", filledAt: new Date() },
      ]);
    }

    const report = await getForwardDriftReport(db, org.organisationId, created.deploymentId);
    expect(report).toMatchObject({
      baseline: { backtestRunId: baselineRunId, segmentKind: "OUT_OF_SAMPLE" },
      closedForwardTradeCount: 5,
    });
    if (!report || !("result" in report) || !report.result) throw new Error("expected a degradation result");
    // Both sides: 100% win rate, positive profit factor — 0 pts win-rate degradation.
    expect(report.result.winRateDegradationPct).toBe(0);
  });
});
