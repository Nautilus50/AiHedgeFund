import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  drawdownPoints,
  equityPoints,
  isTestDatabaseAvailable,
  metricSnapshots,
  parityReports,
  seedOrganisation,
  seedStrategyVersion,
  trades,
  tradingviewVerifications,
  truncateAll,
  type Database,
} from "@arf-os/db";
import {
  backtestRunBelongsToOrg,
  getDrawdownCurve,
  getEquityCurve,
  getMetrics,
  getParityReports,
  getTrades,
  listBacktestRuns,
} from "./backtest-evidence.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("backtest evidence reads (integration)", () => {
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

  async function seedRun(strategyVersionId: string): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
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
    });
    return backtestRunId;
  }

  it("confirms run ownership only for the owning organisation", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    expect(await backtestRunBelongsToOrg(db, alpha.organisationId, backtestRunId)).toBe(true);
    expect(await backtestRunBelongsToOrg(db, beta.organisationId, backtestRunId)).toBe(false);
  });

  it("returns undefined (never another org's rows) for every evidence read", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    await db.insert(trades).values({
      id: generateId<string>(),
      backtestRunId,
      sequenceNumber: 1,
      direction: "LONG",
      entryTime: new Date("2024-01-02T00:00:00Z"),
      entryPrice: "100",
      quantity: "1",
    });

    expect(await getTrades(db, beta.organisationId, backtestRunId)).toBeUndefined();
    expect(await getEquityCurve(db, beta.organisationId, backtestRunId)).toBeUndefined();
    expect(await getDrawdownCurve(db, beta.organisationId, backtestRunId)).toBeUndefined();
    expect(await getMetrics(db, beta.organisationId, backtestRunId)).toBeUndefined();
    expect(await getParityReports(db, beta.organisationId, backtestRunId)).toBeUndefined();

    const ownTrades = await getTrades(db, alpha.organisationId, backtestRunId);
    expect(ownTrades).toHaveLength(1);
  });

  it("orders trades, equity, and drawdown by sequenceNumber", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    await db.insert(trades).values([
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 2,
        direction: "LONG",
        entryTime: new Date("2024-01-03T00:00:00Z"),
        entryPrice: "100",
        quantity: "1",
      },
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 1,
        direction: "LONG",
        entryTime: new Date("2024-01-02T00:00:00Z"),
        entryPrice: "99",
        quantity: "1",
      },
    ]);
    await db.insert(equityPoints).values([
      { id: generateId<string>(), backtestRunId, sequenceNumber: 1, barTime: new Date("2024-01-02T00:00:00Z"), equity: "10000" },
      { id: generateId<string>(), backtestRunId, sequenceNumber: 0, barTime: new Date("2024-01-01T00:00:00Z"), equity: "9999" },
    ]);
    await db.insert(drawdownPoints).values([
      { id: generateId<string>(), backtestRunId, sequenceNumber: 1, barTime: new Date("2024-01-02T00:00:00Z"), drawdown: "0", drawdownPct: "0" },
      { id: generateId<string>(), backtestRunId, sequenceNumber: 0, barTime: new Date("2024-01-01T00:00:00Z"), drawdown: "-1", drawdownPct: "-0.01" },
    ]);

    const orderedTrades = await getTrades(db, org.organisationId, backtestRunId);
    expect(orderedTrades?.map((t) => t.sequenceNumber)).toEqual([1, 2]);

    const orderedEquity = await getEquityCurve(db, org.organisationId, backtestRunId);
    expect(orderedEquity?.map((e) => e.sequenceNumber)).toEqual([0, 1]);

    const orderedDrawdown = await getDrawdownCurve(db, org.organisationId, backtestRunId);
    expect(orderedDrawdown?.map((d) => d.sequenceNumber)).toEqual([0, 1]);
  });

  it("reads only RUN-scoped metric snapshots, not other scopes sharing the same id", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    await db.insert(metricSnapshots).values([
      {
        id: generateId<string>(),
        metricName: "net_profit",
        value: "150.5",
        unit: "usd",
        calculationVersion: "1.0.0",
        scopeType: "RUN",
        scopeId: backtestRunId,
      },
      {
        // Same scopeId reused as a STRATEGY_VERSION-scoped snapshot — must not leak into a RUN-scoped read.
        id: generateId<string>(),
        metricName: "net_profit",
        value: "999",
        unit: "usd",
        calculationVersion: "1.0.0",
        scopeType: "STRATEGY_VERSION",
        scopeId: backtestRunId,
      },
    ]);

    const metrics = await getMetrics(db, org.organisationId, backtestRunId);
    expect(metrics).toHaveLength(1);
    expect(metrics?.[0]?.value).toBe("150.50000000");
  });

  it("returns the parity report for a run", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const backtestRunId = await seedRun(strategy.strategyVersionId);

    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "PARSED",
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });
    await db.insert(parityReports).values({
      id: generateId<string>(),
      backtestRunId,
      verificationId,
      status: "PASS",
      comparison: { netProfit: { local: 150.5, reported: 150.5 } },
    });

    const reports = await getParityReports(db, org.organisationId, backtestRunId);
    expect(reports).toHaveLength(1);
    expect(reports?.[0]?.status).toBe("PASS");
  });

  it("paginates backtest runs for a strategy version, newest last by createdAt/id", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const first = await seedRun(strategy.strategyVersionId);
    const second = await seedRun(strategy.strategyVersionId);

    const page = await listBacktestRuns(db, org.organisationId, { strategyVersionId: strategy.strategyVersionId, limit: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.page.items).toHaveLength(1);
    expect(page.page.nextCursor).toBeDefined();

    const ids = new Set([first, second]);
    expect(ids.has(page.page.items[0]?.id as string)).toBe(true);
  });

  it("never lists another organisation's backtest runs", async () => {
    const alpha = await seedOrganisation(db, { slug: "alpha" });
    const beta = await seedOrganisation(db, { slug: "beta" });
    const strategy = await seedStrategyVersion(db, alpha);
    await seedRun(strategy.strategyVersionId);

    const page = await listBacktestRuns(db, beta.organisationId, { strategyVersionId: strategy.strategyVersionId });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.page.items).toHaveLength(0);
  });
});
