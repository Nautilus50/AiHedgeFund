import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  drawdownPoints,
  isTestDatabaseAvailable,
  metricSnapshots,
  outboxEvents,
  parityReports,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  tradingviewVerifications,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { MetricCalculationJob, ParityCalculationJob } from "@arf-os/event-bus";
import { METRICS_CALCULATION_VERSION } from "@arf-os/metrics";
import {
  handleEquityReconstruction,
  handleMetricCalculation,
  handleParityCalculation,
} from "./handlers.js";

const available = await isTestDatabaseAvailable();

interface SeededRun {
  backtestRunId: string;
  verificationId: string;
  organisationId: string;
}

describe.skipIf(!available)("parity calculation", () => {
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

  /**
   * A verification with a TradingView-sourced backtest run attached, plus the
   * locally calculated snapshots the parity handler reads. `maxDrawdown`
   * seeds a drawdown curve whose peak is that value; omitting it leaves the
   * curve empty, which is how a run with no drawdown looks.
   */
  async function seedRun(options: {
    closedTradeCount: number;
    netProfit: number;
    maxDrawdown?: number;
    verificationId?: string;
  }): Promise<SeededRun> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const verificationId = options.verificationId ?? generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "PARSED",
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });

    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId: strategy.strategyVersionId,
      runnerType: "TRADINGVIEW",
      runnerVersion: "tv-1",
      verificationId,
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2026-01-01T00:00:00Z"),
      toTs: new Date("2026-02-01T00:00:00Z"),
      costModel: {},
      initialCapital: "10000",
      sourceHash: "hash",
    });

    await db.insert(metricSnapshots).values([
      {
        id: generateId<string>(),
        metricName: "closed_trade_count",
        value: String(options.closedTradeCount),
        unit: "count",
        calculationVersion: METRICS_CALCULATION_VERSION,
        scopeType: "RUN",
        scopeId: backtestRunId,
      },
      {
        id: generateId<string>(),
        metricName: "net_profit",
        value: String(options.netProfit),
        unit: "currency",
        calculationVersion: METRICS_CALCULATION_VERSION,
        scopeType: "RUN",
        scopeId: backtestRunId,
      },
    ]);

    if (options.maxDrawdown !== undefined) {
      await db.insert(drawdownPoints).values([
        {
          id: generateId<string>(),
          backtestRunId,
          sequenceNumber: 1,
          barTime: new Date("2026-01-05T00:00:00Z"),
          drawdown: "1.00000000",
          drawdownPct: "0.010000",
        },
        {
          id: generateId<string>(),
          backtestRunId,
          sequenceNumber: 2,
          barTime: new Date("2026-01-06T00:00:00Z"),
          drawdown: String(options.maxDrawdown),
          drawdownPct: "0.050000",
        },
      ]);
    }

    return { backtestRunId, verificationId, organisationId: org.organisationId };
  }

  /**
   * Attaches a Performance Summary upload. Rows are inserted directly rather
   * than through the upload service: this suite covers the parity handler,
   * not object-store round-tripping.
   */
  async function addPerformanceSummary(
    run: SeededRun,
    parsedMetrics: unknown,
    options: { parseStatus?: string; createdAt?: Date } = {},
  ): Promise<void> {
    const artefactId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: run.organisationId,
      objectKey: `key-${artefactId}`,
      contentType: "text/csv",
      sizeBytes: 128,
      checksumSha256: `sum-${artefactId}`,
      kind: "tradingview_performance_summary",
    });

    await db.insert(reportUploads).values({
      id: generateId<string>(),
      verificationId: run.verificationId,
      kind: "PERFORMANCE_SUMMARY",
      rawArtefactId: artefactId,
      parseStatus: options.parseStatus ?? "PARSED",
      parserVersion: "1.0.0",
      parseWarnings: [],
      parsedMetrics,
      uploadedByUserId: generateId<string>(),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
  }

  const MATCHING_SUMMARY = [
    { name: "Net Profit", values: { "All USD": 7.95 } },
    { name: "Total Closed Trades", values: { "All USD": 2 } },
  ];

  async function readReport(backtestRunId: string) {
    const [row] = await db.select().from(parityReports).where(eq(parityReports.backtestRunId, backtestRunId));
    return row;
  }

  it("stores a PASS when the local figures match what TradingView reported", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });
    await addPerformanceSummary(run, MATCHING_SUMMARY);

    const result = await handleParityCalculation(db, run);

    expect(result.status).toBe("PASS");
    expect(result.firstDivergence).toBeUndefined();

    const row = await readReport(run.backtestRunId);
    expect(row?.status).toBe("PASS");
    expect(row?.firstDivergence).toBeNull();
    expect(row?.verificationId).toBe(run.verificationId);
  });

  it("stores a FAIL naming the first divergent field when trade counts differ", async () => {
    const run = await seedRun({ closedTradeCount: 3, netProfit: 7.95 });
    // Local reconstructed 3 closed trades, the report states 2. A count
    // mismatch is a reconstruction defect, so parity fails it outright
    // rather than treating it as a tolerable difference.
    await addPerformanceSummary(run, MATCHING_SUMMARY);

    const result = await handleParityCalculation(db, run);

    expect(result.status).toBe("FAIL");
    expect(result.firstDivergence).toBe("closedTradeCount");
    expect((await readReport(run.backtestRunId))?.firstDivergence).toBe("closedTradeCount");
  });

  it("stores INSUFFICIENT_DATA when no performance summary has been uploaded", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });

    const result = await handleParityCalculation(db, run);

    // Not an error: a verification whose summary is still pending is an
    // ordinary state of the workflow, and the verdict records that.
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect((await readReport(run.backtestRunId))?.status).toBe("INSUFFICIENT_DATA");
  });

  it("ignores an upload whose parse failed", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });
    await addPerformanceSummary(run, null, { parseStatus: "FAILED" });

    expect((await handleParityCalculation(db, run)).status).toBe("INSUFFICIENT_DATA");
  });

  it("compares against the most recent parsed summary when a researcher re-uploads", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });
    await addPerformanceSummary(
      run,
      [
        { name: "Net Profit", values: { "All USD": 999 } },
        { name: "Total Closed Trades", values: { "All USD": 2 } },
      ],
      { createdAt: new Date("2026-03-01T00:00:00Z") },
    );
    await addPerformanceSummary(run, MATCHING_SUMMARY, { createdAt: new Date("2026-03-02T00:00:00Z") });

    // The correction supersedes the earlier upload; both remain on record.
    expect((await handleParityCalculation(db, run)).status).toBe("PASS");
  });

  it("replaces rather than duplicates the report when the job is replayed", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });
    await addPerformanceSummary(run, MATCHING_SUMMARY);

    await handleParityCalculation(db, run);
    await handleParityCalculation(db, run);

    const rows = await db
      .select()
      .from(parityReports)
      .where(
        and(
          eq(parityReports.backtestRunId, run.backtestRunId),
          eq(parityReports.verificationId, run.verificationId),
        ),
      );

    // parity_reports has no unique constraint on (run, verification), so
    // idempotency is the handler's responsibility, not the schema's.
    expect(rows).toHaveLength(1);
  });

  it("fails loudly when the metric snapshots parity depends on are missing", async () => {
    const org = await seedOrganisation(db, { slug: "no-metrics" });
    const strategy = await seedStrategyVersion(db, org);
    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "PARSED",
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId: strategy.strategyVersionId,
      runnerType: "TRADINGVIEW",
      runnerVersion: "tv-1",
      verificationId,
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2026-01-01T00:00:00Z"),
      toTs: new Date("2026-02-01T00:00:00Z"),
      costModel: {},
      initialCapital: "10000",
      sourceHash: "hash",
    });

    // Running out of order is a defect, not a comparison outcome. Persisting
    // INSUFFICIENT_DATA here would disguise a broken pipeline as a verdict.
    await expect(handleParityCalculation(db, { backtestRunId, verificationId })).rejects.toThrow(
      /metric calculation must run before parity/,
    );

    const rows = await db.select().from(parityReports).where(eq(parityReports.backtestRunId, backtestRunId));
    expect(rows).toHaveLength(0);
  });

  it("compares max drawdown from the reconstructed curve against the reported figure", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95, maxDrawdown: 5 });
    await addPerformanceSummary(run, [
      ...MATCHING_SUMMARY,
      // 20% from the local peak of 5, beyond the 5% warn tolerance.
      { name: "Max Drawdown", values: { "All USD": 6 } },
    ]);

    const result = await handleParityCalculation(db, run);

    expect(result.status).toBe("FAIL");
    expect(result.firstDivergence).toBe("maxDrawdown");
  });

  it("records both sides of the comparison so an investigator need not re-run it", async () => {
    const run = await seedRun({ closedTradeCount: 2, netProfit: 7.95 });
    await addPerformanceSummary(run, MATCHING_SUMMARY);

    await handleParityCalculation(db, run);

    const comparison = (await readReport(run.backtestRunId))?.comparison as {
      local: { netProfit: number; closedTradeCount: number };
      reported: { netProfit: number };
      comparisons: { field: string; severity: string }[];
    };

    expect(comparison.local).toMatchObject({ netProfit: 7.95, closedTradeCount: 2 });
    expect(comparison.reported.netProfit).toBe(7.95);
    expect(comparison.comparisons.map((c) => c.field)).toContain("netProfit");
  });
});

describe.skipIf(!available)("metrics.calculated emission", () => {
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

  async function seedBareRun(verificationId: string | null): Promise<string> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    if (verificationId) {
      await db.insert(tradingviewVerifications).values({
        id: verificationId,
        strategyVersionId: strategy.strategyVersionId,
        status: "PARSED",
        requiredSymbol: "BTCUSD",
        requiredTimeframe: "60",
        requestedByUserId: org.userId,
      });
    }

    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId: strategy.strategyVersionId,
      runnerType: verificationId ? "TRADINGVIEW" : "LOCAL_RUNNER",
      runnerVersion: "r-1",
      verificationId,
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "IN_SAMPLE",
      fromTs: new Date("2026-01-01T00:00:00Z"),
      toTs: new Date("2026-02-01T00:00:00Z"),
      costModel: {},
      initialCapital: "10000",
      sourceHash: "hash",
    });

    return backtestRunId;
  }

  async function readEmitted() {
    return db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "metrics.calculated"));
  }

  it("emits an event carrying the verification, so the relay can enqueue parity", async () => {
    const verificationId = generateId<string>();
    const backtestRunId = await seedBareRun(verificationId);

    const result = await handleMetricCalculation(db, { backtestRunId });

    expect(result.parityQueued).toBe(true);
    const [event] = await readEmitted();
    expect(event?.aggregateId).toBe(backtestRunId);
    expect(event?.payload).toEqual({ backtestRunId, verificationId });
    // The consuming worker parses this with ParityCalculationJob, which
    // requires both fields — assert the contract here rather than discover
    // a rejected payload in production.
    expect(() => ParityCalculationJob.parse(event?.payload)).not.toThrow();
  });

  it("does not emit for a run with no verification, which has nothing to compare against", async () => {
    const backtestRunId = await seedBareRun(null);

    const result = await handleMetricCalculation(db, { backtestRunId });

    expect(result.parityQueued).toBe(false);
    expect(await readEmitted()).toHaveLength(0);
  });

  describe("equity.reconstructed emission", () => {
    async function readEquityEvents() {
      return db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "equity.reconstructed"));
    }

    it("emits an event the relay can route to metric calculation", async () => {
      const backtestRunId = await seedBareRun(null);

      await handleEquityReconstruction(db, { backtestRunId, initialCapital: "10000" });

      const [event] = await readEquityEvents();
      expect(event?.aggregateId).toBe(backtestRunId);
      expect(event?.actor).toBe("worker-analytics");
      expect(event?.payload).toEqual({ backtestRunId });
      expect(() => MetricCalculationJob.parse(event?.payload)).not.toThrow();
    });

    it("emits for a run with no closed trades, whose metrics are still worth recording", async () => {
      const backtestRunId = await seedBareRun(null);

      const result = await handleEquityReconstruction(db, { backtestRunId, initialCapital: "10000" });

      // One point, not zero: the curve opens at initial capital before any
      // trade closes, so an empty ledger still has a starting point.
      expect(result.equityPointCount).toBe(1);
      expect(result.maxDrawdown).toBe("0.00000000");
      expect(await readEquityEvents()).toHaveLength(1);
    });

    it("emits once per replay rather than accumulating, matching the curve rewrite", async () => {
      const backtestRunId = await seedBareRun(null);

      await handleEquityReconstruction(db, { backtestRunId, initialCapital: "10000" });
      await handleEquityReconstruction(db, { backtestRunId, initialCapital: "10000" });

      // Two runs of the job legitimately produce two events: the relay
      // dedupes on its own row id via deterministicJobId, so replay safety
      // lives there rather than in an outbox uniqueness constraint.
      const events = await readEquityEvents();
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.id)).size).toBe(2);
    });
  });
});
