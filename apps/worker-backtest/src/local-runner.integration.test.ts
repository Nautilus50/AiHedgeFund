import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId, sha256Hex } from "@arf-os/contracts";
import {
  artefacts,
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  datasetVersions,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  seedStrategyVersion,
  strategyDefinitions,
  trades,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { EquityReconstructionJob, routeOutboxEvent } from "@arf-os/event-bus";
import { handleLocalRunnerExecution } from "./handlers.js";
import { createObjectStoreClient } from "./object-store.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — hasCredentials below will be false and this suite is skipped.
}

const dbAvailable = await isTestDatabaseAvailable();

function readCredentials():
  | { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
  | undefined {
  const endpoint = process.env.OBJECT_STORE_ENDPOINT;
  const bucket = process.env.OBJECT_STORE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

const credentials = readCredentials();
const available = dbAvailable && credentials !== undefined;

const GOLDEN_CSV = readFileSync(
  fileURLToPath(new URL("../../../pine/fixtures/ohlcv/golden-crossover.csv", import.meta.url)),
  "utf-8",
);

function goldenDefinition() {
  return {
    schemaVersion: "1.0.0",
    strategy: { name: "Golden Crossover", family: "trend", thesis: "SMA crossover", directions: ["long"] },
    market: {
      assetClass: "crypto",
      symbols: ["BTCUSD"],
      timeframe: "1h",
      timezone: "UTC",
      session: "24x7",
      chartType: "standard_ohlc",
    },
    signals: { longEntry: "ta.crossover(ta.sma(close, 3), ta.sma(close, 7))", shortEntry: "false" },
    execution: {
      entryOrder: "market_next_bar",
      pyramiding: 0,
      allowReversal: false,
      processOnClose: true,
      calcOnEveryTick: false,
    },
    risk: {
      sizingModel: "percent_of_equity",
      sizePercent: 10,
      leverage: 1,
      stopLoss: { type: "fixed_percent", valueParameter: "stop_pct" },
      takeProfit: { type: "fixed_percent", valueParameter: "target_pct" },
      oneStopOneTarget: true,
    },
    costs: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
    parameters: [
      { key: "stop_pct", type: "float", default: 5, min: 0, max: 50, step: 0.5 },
      { key: "target_pct", type: "float", default: 10, min: 0, max: 100, step: 0.5 },
    ],
    segments: { warmupBars: 7, selectionMode: "fixed_parameters", embargoBars: 0 },
    falsification: ["Crossover lag underperforms buy-and-hold in strong trends"],
  };
}

/**
 * Proves the local runner's whole pipeline end to end against real
 * Postgres and a real R2 bucket: seeded SDL + dataset -> compile/run ->
 * trade ledger -> the *existing* trades.normalised -> equity reconstruction
 * chain, unmodified by this feature (CLAUDE.md 21.2).
 */
describe.skipIf(!available)("local runner execution (integration)", () => {
  let db: Database;
  let s3: ReturnType<typeof createObjectStoreClient>;
  let bucket: string;
  const uploadedKeys: string[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    const creds = credentials;
    if (!creds) throw new Error("unreachable: describe.skipIf already guarded this");
    bucket = creds.bucket;
    s3 = createObjectStoreClient(creds);
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterEach(async () => {
    while (uploadedKeys.length > 0) {
      const key = uploadedKeys.pop();
      if (key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  });

  async function seed(): Promise<{ organisationId: string; backtestRunId: string }> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    await db.insert(strategyDefinitions).values({
      id: generateId<string>(),
      strategyVersionId: strategy.strategyVersionId,
      definition: goldenDefinition(),
      definitionHash: "golden-fixture-hash",
    });

    const csvBytes = new TextEncoder().encode(GOLDEN_CSV);
    const checksumSha256 = sha256Hex(csvBytes);
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    const objectKey = `test/orgs/${org.organisationId}/datasets/${datasetVersionId}/golden-crossover.csv`;

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: csvBytes, ContentType: "text/csv" }));
    uploadedKeys.push(objectKey);

    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: org.organisationId,
      objectKey,
      contentType: "text/csv",
      sizeBytes: csvBytes.byteLength,
      checksumSha256,
      kind: "ohlcv_dataset",
    });

    await db.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId: org.organisationId,
      symbol: "BTCUSD",
      timeframe: "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-01T14:00:00Z"),
      barCount: 15,
      checksumSha256,
      artefactId,
    });

    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
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
    });

    return { organisationId: org.organisationId, backtestRunId };
  }

  it("runs the strategy, writes the trade ledger, and marks the run succeeded", async () => {
    const seeded = await seed();

    const result = await handleLocalRunnerExecution(db, { s3, bucket }, { backtestRunId: seeded.backtestRunId });

    expect(result).toEqual({ status: "SUCCEEDED", tradeCount: 1 });

    const ledger = await db
      .select()
      .from(trades)
      .where(eq(trades.backtestRunId, seeded.backtestRunId))
      .orderBy(asc(trades.sequenceNumber));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      direction: "LONG",
      entryPrice: "110.00000000",
      exitPrice: "121.00000000",
      exitReason: "take_profit",
    });

    const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, seeded.backtestRunId));
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.startedAt).not.toBeNull();
    expect(run?.completedAt).not.toBeNull();
  });

  it("emits trades.normalised in the exact shape equity reconstruction already consumes", async () => {
    const seeded = await seed();
    await handleLocalRunnerExecution(db, { s3, bucket }, { backtestRunId: seeded.backtestRunId });

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "trades.normalised"));
    if (event === undefined) throw new Error("expected a trades.normalised outbox event");

    expect(event.aggregateId).toBe(seeded.backtestRunId);
    expect(() => EquityReconstructionJob.parse(event.payload)).not.toThrow();
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      "equity-reconstruction",
    );
  });

  it("marks the run FAILED_TERMINAL, with no trade ledger, for an unsupported SDL feature", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    const definition = goldenDefinition();
    definition.risk.stopLoss = { type: "risk_multiple", valueParameter: "r_mult" };
    await db.insert(strategyDefinitions).values({
      id: generateId<string>(),
      strategyVersionId: strategy.strategyVersionId,
      definition,
      definitionHash: "unsupported-fixture-hash",
    });

    const csvBytes = new TextEncoder().encode(GOLDEN_CSV);
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    const objectKey = `test/orgs/${org.organisationId}/datasets/${datasetVersionId}/golden-crossover.csv`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: csvBytes, ContentType: "text/csv" }));
    uploadedKeys.push(objectKey);

    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: org.organisationId,
      objectKey,
      contentType: "text/csv",
      sizeBytes: csvBytes.byteLength,
      checksumSha256: sha256Hex(csvBytes),
      kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId: org.organisationId,
      symbol: "BTCUSD",
      timeframe: "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-01T14:00:00Z"),
      barCount: 15,
      checksumSha256: sha256Hex(csvBytes),
      artefactId,
    });

    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
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
    });

    const result = await handleLocalRunnerExecution(db, { s3, bucket }, { backtestRunId });
    expect(result).toEqual({ status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "COMPILE_FAILED" });

    const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, backtestRunId));
    expect(run?.status).toBe("FAILED_TERMINAL");
    expect(run?.errorCode).toBe("COMPILE_FAILED");

    const ledger = await db.select().from(trades).where(eq(trades.backtestRunId, backtestRunId));
    expect(ledger).toHaveLength(0);
  });

  it("replaces rather than duplicates the ledger when replayed", async () => {
    const seeded = await seed();
    await handleLocalRunnerExecution(db, { s3, bucket }, { backtestRunId: seeded.backtestRunId });
    await handleLocalRunnerExecution(db, { s3, bucket }, { backtestRunId: seeded.backtestRunId });

    const ledger = await db.select().from(trades).where(eq(trades.backtestRunId, seeded.backtestRunId));
    expect(ledger).toHaveLength(1);
  });
});
