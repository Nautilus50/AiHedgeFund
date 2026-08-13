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
import { QUEUE_NAMES, ReportParseJob, routeOutboxEvent } from "@arf-os/event-bus";
import { completeReportUpload } from "./verification.js";

const available = await isTestDatabaseAvailable();

/**
 * A stub standing in for object storage. The R2-backed suite in
 * report-ingestion.integration.test.ts covers the real round trip; this one
 * is about what gets persisted and emitted afterwards, so stubbing keeps it
 * runnable without storage credentials.
 */
function stubS3(): S3Client {
  return {
    send: async () => ({
      ContentType: "text/csv",
      Body: { transformToByteArray: async () => new TextEncoder().encode("irrelevant,for,this,suite") },
    }),
  } as unknown as S3Client;
}

/**
 * `completeReportUpload` no longer parses (that moved to the async
 * `handleReportParse` worker job — see
 * apps/worker-backtest/src/report-parse.integration.test.ts). This suite
 * covers what's left of its contract: the upload is durably stored PENDING,
 * and the handoff to the report-parse job is correctly shaped and routed.
 */
describe.skipIf(!available)("upload completion → report-parse handoff", () => {
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
    return db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "report_upload.uploaded"));
  }

  it("stores the upload PENDING and emits a report-parse job the worker can consume", async () => {
    const seeded = await seed();

    const result = await completeReportUpload(db, stubS3(), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
      backtestRunId: seeded.backtestRunId,
    });

    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parseStatus).toBe("PENDING");
    expect(upload?.parsedTrades).toBeNull();

    const [event] = await readEmitted();
    expect(event).toBeDefined();
    if (!event) return;

    expect(event.aggregateId).toBe(result.reportUploadId);
    expect(event.payload).toEqual({
      reportUploadId: result.reportUploadId,
      verificationId: seeded.verificationId,
      organisationId: seeded.organisationId,
      objectKey: "key.csv",
      kind: "LIST_OF_TRADES",
      backtestRunId: seeded.backtestRunId,
    });
    // The consuming worker parses with this schema, and the relay must route
    // it to the report-parse queue — assert both contracts here.
    expect(() => ReportParseJob.parse(event.payload)).not.toThrow();
    expect(
      routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue,
    ).toBe(QUEUE_NAMES.reportParse);
  });

  it("omits backtestRunId from the job payload when no run is supplied", async () => {
    const seeded = await seed();

    await completeReportUpload(db, stubS3(), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
    });

    const [event] = await readEmitted();
    const payload = ReportParseJob.parse(event?.payload);
    expect(payload.backtestRunId).toBeUndefined();
  });

  it("emits unconditionally for a Performance Summary too — kind-based branching is the worker's job now", async () => {
    const seeded = await seed();

    await completeReportUpload(db, stubS3(), "bucket", {
      organisationId: seeded.organisationId,
      verificationId: seeded.verificationId,
      kind: "PERFORMANCE_SUMMARY",
      objectKey: "key.csv",
      uploadedByUserId: seeded.userId,
      backtestRunId: seeded.backtestRunId,
    });

    const [event] = await readEmitted();
    expect(event).toBeDefined();
    expect(ReportParseJob.parse(event?.payload).kind).toBe("PERFORMANCE_SUMMARY");
  });
});
