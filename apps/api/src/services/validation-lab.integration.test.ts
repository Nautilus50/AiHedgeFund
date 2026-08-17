import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedStrategyVersion,
  trades,
  truncateAll,
  type Database,
  type SeededStrategy,
} from "@arf-os/db";
import { getValidationLabReport } from "./validation-lab.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("validation lab (integration)", () => {
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

  async function seedRun(
    strategyVersionId: string,
    overrides: {
      symbol?: string;
      timeframe?: string;
      segmentKind?: string;
      status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "CANCELLED";
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "TRADINGVIEW",
      runnerVersion: "tv-1",
      symbol: overrides.symbol ?? "BTCUSD",
      timeframe: overrides.timeframe ?? "60",
      segmentKind: overrides.segmentKind ?? "IN_SAMPLE",
      status: overrides.status ?? "SUCCEEDED",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: { commissionPct: 0.04 },
      initialCapital: "10000",
      sourceHash: "hash",
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    });
    return backtestRunId;
  }

  async function seedTrades(backtestRunId: string, netPnls: number[]): Promise<void> {
    await db.insert(trades).values(
      netPnls.map((netPnl, index) => ({
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: index + 1,
        direction: (index % 2 === 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
        entryTime: new Date(`2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`),
        exitTime: new Date(`2024-01-${String(index + 1).padStart(2, "0")}T06:00:00Z`),
        entryPrice: "100",
        exitPrice: "101",
        quantity: "1",
        netPnl: String(netPnl),
      })),
    );
  }

  it("returns undefined for a run belonging to another organisation", async () => {
    const alpha = await seedOrganisation(db, { slug: "vl-alpha" });
    const beta = await seedOrganisation(db, { slug: "vl-beta" });
    const strategy: SeededStrategy = await seedStrategyVersion(db, alpha);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    expect(await getValidationLabReport(db, beta.organisationId, backtestRunId)).toBeUndefined();
    expect(await getValidationLabReport(db, alpha.organisationId, backtestRunId)).toBeDefined();
  });

  it("echoes the target run id and a computedAt timestamp", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const backtestRunId = await seedRun(strategy.strategyVersionId);
    await seedTrades(backtestRunId, [10, -5]);

    const report = await getValidationLabReport(db, org.organisationId, backtestRunId);
    expect(report?.targetRunId).toBe(backtestRunId);
    expect(report?.computedAt).toBeTruthy();
    expect(new Date(report?.computedAt ?? "").getTime()).not.toBeNaN();
  });

  it("excludes a sibling on a different symbol from the degradation comparison", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE", symbol: "BTCUSD" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", symbol: "ETHUSD" });

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.degradation).toEqual([]);
  });

  it("excludes a sibling on a different timeframe from the degradation comparison", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE", timeframe: "60" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", timeframe: "240" });

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.degradation).toEqual([]);
  });

  it("excludes a non-SUCCEEDED sibling from the degradation comparison", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", status: "FAILED_TERMINAL" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", status: "QUEUED" });

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.degradation).toEqual([]);
  });

  it("returns every matching sibling, most-recent-first, not just one", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE" });
    const older = await seedRun(strategy.strategyVersionId, {
      segmentKind: "OUT_OF_SAMPLE",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const newer = await seedRun(strategy.strategyVersionId, {
      segmentKind: "VALIDATION",
      createdAt: new Date("2024-06-01T00:00:00Z"),
    });

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.degradation.map((d) => d.siblingRunId)).toEqual([newer, older]);
  });

  it("returns an empty degradation list when no comparable sibling exists", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE" });

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.degradation).toEqual([]);
  });

  it("computes segment distribution counts across a hand-seeded mix of kinds and statuses", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE", status: "SUCCEEDED" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "IN_SAMPLE", status: "SUCCEEDED" });
    await seedRun(strategy.strategyVersionId, { segmentKind: "OUT_OF_SAMPLE", status: "FAILED_TERMINAL" });

    const report = await getValidationLabReport(db, org.organisationId, target);
    const distribution = new Map(report?.segmentDistribution.map((r) => [`${r.segmentKind}:${r.status}`, r.total]));
    expect(distribution.get("IN_SAMPLE:SUCCEEDED")).toBe(2);
    expect(distribution.get("OUT_OF_SAMPLE:FAILED_TERMINAL")).toBe(1);
  });

  it("computes trade-removal concentration and directional breakdown from hand-calculated trades", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const target = await seedRun(strategy.strategyVersionId);
    // LONG +100, SHORT -10, LONG +50, SHORT -10 -> total net profit 130.
    await seedTrades(target, [100, -10, 50, -10]);

    const report = await getValidationLabReport(db, org.organisationId, target);
    expect(report?.tradeRemovalConcentration.totalNetProfit).toBe("130.00000000");
    expect(report?.tradeRemovalConcentration.curve.map((c) => c.tradeNumber)).toEqual([1, 3, 2, 4]);
    expect(report?.directionalBreakdown.long.netProfit).toBe("150.00000000");
    expect(report?.directionalBreakdown.short.netProfit).toBe("-20.00000000");
  });
});
