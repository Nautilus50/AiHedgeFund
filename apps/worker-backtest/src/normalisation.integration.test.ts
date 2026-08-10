import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  trades,
  tradingviewVerifications,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { EquityReconstructionJob } from "@arf-os/event-bus";
import type { ParsedTrade } from "@arf-os/pine";
import { handleTradeNormalisation } from "./handlers.js";

const available = await isTestDatabaseAvailable();

/** Mirrors the shape the List of Trades parser produces for the repo's fixture. */
const PARSED: ParsedTrade[] = [
  {
    tradeNumber: 1,
    direction: "LONG",
    entryTime: "2024-01-15T08:30:00.000Z",
    entryPrice: 43000.25,
    exitTime: "2024-01-16T10:00:00.000Z",
    exitPrice: 43500.5,
    quantity: 0.01,
    grossPnl: 15.25,
    grossPnlPct: 1.53,
    isOpen: false,
  },
  {
    tradeNumber: 2,
    direction: "LONG",
    entryTime: "2024-01-17T09:15:00.000Z",
    entryPrice: 44290,
    exitTime: "2024-01-18T14:00:00.000Z",
    exitPrice: 44200.75,
    quantity: 0.01,
    grossPnl: -8.3,
    grossPnlPct: -0.83,
    isOpen: false,
  },
  {
    // Still open: no exit, no profit figure.
    tradeNumber: 3,
    direction: "SHORT",
    entryTime: "2024-01-20T11:45:00.000Z",
    entryPrice: 45000,
    quantity: 0.02,
    isOpen: true,
  },
];

describe.skipIf(!available)("trade normalisation", () => {
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

  async function seed(options: {
    parsedTrades: unknown;
    kind?: "LIST_OF_TRADES" | "PERFORMANCE_SUMMARY";
    initialCapital?: string;
  }): Promise<{ backtestRunId: string; reportUploadId: string }> {
    const org = await seedOrganisation(db);
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
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-02-01T00:00:00Z"),
      costModel: { commissionPct: 0.04 },
      initialCapital: options.initialCapital ?? "10000",
      sourceHash: "hash",
    });

    const artefactId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: org.organisationId,
      objectKey: `key-${artefactId}`,
      contentType: "text/csv",
      sizeBytes: 256,
      checksumSha256: `sum-${artefactId}`,
      kind: "tradingview_list_of_trades",
    });

    const reportUploadId = generateId<string>();
    await db.insert(reportUploads).values({
      id: reportUploadId,
      verificationId,
      kind: options.kind ?? "LIST_OF_TRADES",
      rawArtefactId: artefactId,
      parseStatus: "PARSED",
      parserVersion: "1.0.0",
      parseWarnings: [],
      parsedTrades: options.parsedTrades,
      uploadedByUserId: org.userId,
    });

    return { backtestRunId, reportUploadId };
  }

  async function readLedger(backtestRunId: string) {
    return db
      .select()
      .from(trades)
      .where(eq(trades.backtestRunId, backtestRunId))
      .orderBy(asc(trades.sequenceNumber));
  }

  it("writes the ledger from the stored parse result", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    const result = await handleTradeNormalisation(db, seeded);

    expect(result).toEqual({ tradeCount: 3, openTradeCount: 1 });

    const ledger = await readLedger(seeded.backtestRunId);
    expect(ledger).toHaveLength(3);
    expect(ledger.map((t) => t.sequenceNumber)).toEqual([1, 2, 3]);
    expect(ledger[0]).toMatchObject({ direction: "LONG", netPnl: "15.25000000", fees: "0.00000000" });
    expect(ledger[1]?.netPnl).toBe("-8.30000000");
  });

  it("records the reported profit as both gross and net, with fees at zero", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    await handleTradeNormalisation(db, seeded);

    const [first] = await readLedger(seeded.backtestRunId);
    // A TradingView export states one profit figure and no fee breakdown.
    // Leaving netPnl null would make every downstream metric silently see
    // zero closed trades, so the reported figure fills both columns and
    // fees stays 0, meaning "not separately reported".
    expect(first?.grossPnl).toBe("15.25000000");
    expect(first?.netPnl).toBe("15.25000000");
    expect(first?.fees).toBe("0.00000000");
  });

  it("leaves an open trade without an exit or a profit figure", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    await handleTradeNormalisation(db, seeded);

    const ledger = await readLedger(seeded.backtestRunId);
    const open = ledger.find((t) => t.sequenceNumber === 3);
    expect(open?.exitTime).toBeNull();
    expect(open?.exitPrice).toBeNull();
    // Not zero: the trade has not realised a profit, which is different
    // from having realised none.
    expect(open?.netPnl).toBeNull();
    expect(open?.grossPnl).toBeNull();
  });

  it("emits trades.normalised carrying the run's capital, as equity reconstruction needs", async () => {
    const seeded = await seed({ parsedTrades: PARSED, initialCapital: "25000" });

    await handleTradeNormalisation(db, seeded);

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "trades.normalised"));

    expect(event?.aggregateId).toBe(seeded.backtestRunId);
    expect(event?.actor).toBe("worker-backtest");
    expect(event?.payload).toEqual({
      backtestRunId: seeded.backtestRunId,
      initialCapital: "25000.00000000",
    });

    // The contract that matters: the consuming worker parses this payload
    // with EquityReconstructionJob, so a shape it rejects would fail only
    // once in production. Assert it here instead.
    expect(() => EquityReconstructionJob.parse(event?.payload)).not.toThrow();
  });

  it("replaces rather than duplicates the ledger when replayed", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    await handleTradeNormalisation(db, seeded);
    await handleTradeNormalisation(db, seeded);

    expect(await readLedger(seeded.backtestRunId)).toHaveLength(3);
  });

  it("writes an empty ledger for a report that paired no trades", async () => {
    const seeded = await seed({ parsedTrades: [] });

    const result = await handleTradeNormalisation(db, seeded);

    expect(result).toEqual({ tradeCount: 0, openTradeCount: 0 });
    expect(await readLedger(seeded.backtestRunId)).toHaveLength(0);
    // Still emitted: downstream metrics for a strategy that took no trades
    // are a legitimate result worth recording.
    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "trades.normalised"));
    expect(events).toHaveLength(1);
  });

  it("refuses an upload with no parsed trades rather than writing an empty ledger", async () => {
    const seeded = await seed({ parsedTrades: null });

    // An empty ledger would read as "this strategy took no trades", which is
    // a different claim from "the ledger was never parsed".
    await expect(handleTradeNormalisation(db, seeded)).rejects.toThrow(/no parsed trades/);
    expect(await readLedger(seeded.backtestRunId)).toHaveLength(0);
  });

  it("refuses a Performance Summary, which yields no ledger", async () => {
    const seeded = await seed({ parsedTrades: PARSED, kind: "PERFORMANCE_SUMMARY" });

    await expect(handleTradeNormalisation(db, seeded)).rejects.toThrow(/only a LIST_OF_TRADES/);
  });

  it("refuses an unknown report upload", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    await expect(
      handleTradeNormalisation(db, { ...seeded, reportUploadId: generateId<string>() }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses an unknown backtest run", async () => {
    const seeded = await seed({ parsedTrades: PARSED });

    await expect(
      handleTradeNormalisation(db, { ...seeded, backtestRunId: generateId<string>() }),
    ).rejects.toThrow(/Backtest run .* not found/);
  });
});
