import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  tradingviewVerifications,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { TradeNormalisationJob, routeOutboxEvent, QUEUE_NAMES } from "@arf-os/event-bus";
import { completeReportUpload } from "./verification.js";

const available = await isTestDatabaseAvailable();
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../pine/fixtures/tradingview");

/**
 * A stub standing in for object storage. The R2-backed suite in
 * report-ingestion.integration.test.ts covers the real round trip; this one
 * is about what gets persisted and emitted afterwards, so stubbing keeps it
 * runnable without storage credentials.
 */
function stubS3(body: string): S3Client {
  return {
    send: async () => ({
      ContentType: "text/csv",
      Body: { transformToByteArray: async () => new TextEncoder().encode(body) },
    }),
  } as unknown as S3Client;
}

describe.skipIf(!available)("upload completion → normalisation handoff", () => {
  let db: Database;
  const ledgerCsv = readFileSync(join(fixturesDir, "list-of-trades-comma-iso.csv"), "utf8");
  const summaryCsv = readFileSync(join(fixturesDir, "performance-summary-comma.csv"), "utf8");

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  async function seed(): Promise<{ organisationId: string; verificationId: string; backtestRunId: string; userId: string }> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "PENDING",
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
      costModel: {},
      initialCapital: "10000",
      sourceHash: "hash",
    });

    return { organisationId: org.organisationId, verificationId, backtestRunId, userId: org.userId };
  }

  async function readEmitted() {
    return db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "report_upload.parsed"));
  }

  it("persists the parsed ledger and emits an event normalisation can consume", async () => {
    const seeded = await seed();

    const result = await completeReportUpload(db, stubS3(ledgerCsv), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
      backtestRunId: seeded.backtestRunId,
    });

    expect(result.normalisationQueued).toBe(true);

    const [upload] = await db
      .select()
      .from(reportUploads)
      .where(eq(reportUploads.id, result.reportUploadId));
    // The fixture pairs entry/exit rows into 3 trades, one still open.
    expect(upload?.parsedTrades).toHaveLength(3);
    expect(upload?.parsedMetrics).toBeNull();

    const [event] = await readEmitted();
    expect(event).toBeDefined();
    if (!event) return;

    expect(event.aggregateId).toBe(result.reportUploadId);
    expect(event.payload).toEqual({
      backtestRunId: seeded.backtestRunId,
      reportUploadId: result.reportUploadId,
    });
    // The consuming worker parses with this schema, and the relay must route
    // it to the normalisation queue — assert both contracts here.
    expect(() => TradeNormalisationJob.parse(event.payload)).not.toThrow();
    expect(
      routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue,
    ).toBe(QUEUE_NAMES.tradeNormalisation);
  });

  it("does not emit when no run is supplied, but still stores the ledger as evidence", async () => {
    const seeded = await seed();

    const result = await completeReportUpload(db, stubS3(ledgerCsv), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
    });

    expect(result.normalisationQueued).toBe(false);
    const [upload] = await db
      .select()
      .from(reportUploads)
      .where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parsedTrades).toHaveLength(3);
    expect(await readEmitted()).toHaveLength(0);
  });

  it("does not emit for a performance summary, which yields no ledger", async () => {
    const seeded = await seed();

    const result = await completeReportUpload(db, stubS3(summaryCsv), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "PERFORMANCE_SUMMARY",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
      backtestRunId: seeded.backtestRunId,
    });

    expect(result.normalisationQueued).toBe(false);
    const [upload] = await db
      .select()
      .from(reportUploads)
      .where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parsedMetrics).not.toBeNull();
    expect(upload?.parsedTrades).toBeNull();
    expect(await readEmitted()).toHaveLength(0);
  });

  it("stores a failed parse without emitting, keeping the raw artefact", async () => {
    const seeded = await seed();

    const result = await completeReportUpload(db, stubS3("not,a,tradingview,export\n1,2,3,4"), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
      backtestRunId: seeded.backtestRunId,
    });

    expect(result.normalisationQueued).toBe(false);
    const [upload] = await db
      .select()
      .from(reportUploads)
      .where(eq(reportUploads.id, result.reportUploadId));
    // A rejected parse must not cost us the evidence (CLAUDE.md 15.1).
    expect(upload?.parseStatus).toBe("FAILED");
    expect(upload?.rawArtefactId).toBe(result.artefactId);
    expect(upload?.parsedTrades).toBeNull();
    expect(await readEmitted()).toHaveLength(0);
  });
});
