import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId, sha256Hex } from "@arf-os/contracts";
import {
  artefacts,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  truncateAll,
  tradingviewVerifications,
  type Database,
} from "@arf-os/db";
import { QUEUE_NAMES, routeOutboxEvent, TradeNormalisationJob } from "@arf-os/event-bus";
import { handleReportParse } from "./handlers.js";
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

const fixturesDir = fileURLToPath(new URL("../../../pine/fixtures/tradingview", import.meta.url));

/**
 * The async half of upload ingestion (CLAUDE.md 16.1): the API durably
 * stores the raw upload and hands off via the outbox; this job re-fetches
 * the object by key and parses it. Exercises real R2 and real Postgres, the
 * same way local-runner.integration.test.ts does for the runner.
 */
describe.skipIf(!available)("report parse (integration)", () => {
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

  async function seed(
    fixtureName: string,
    kind: "LIST_OF_TRADES" | "PERFORMANCE_SUMMARY",
  ): Promise<{ reportUploadId: string; verificationId: string; organisationId: string; objectKey: string }> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "UPLOADED",
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });

    const content = readFileSync(`${fixturesDir}/${fixtureName}`, "utf-8");
    const bytes = new TextEncoder().encode(content);
    const objectKey = `test/orgs/${org.organisationId}/verifications/${verificationId}/${fixtureName}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: "text/csv" }));
    uploadedKeys.push(objectKey);

    const artefactId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: org.organisationId,
      objectKey,
      contentType: "text/csv",
      sizeBytes: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
      kind: `tradingview_${kind.toLowerCase()}`,
    });

    const reportUploadId = generateId<string>();
    await db.insert(reportUploads).values({
      id: reportUploadId,
      verificationId,
      kind,
      rawArtefactId: artefactId,
      uploadedByUserId: org.userId,
      // parseStatus left at its PENDING default — this is exactly the row
      // shape completeReportUpload leaves behind.
    });

    return { reportUploadId, verificationId, organisationId: org.organisationId, objectKey };
  }

  it("parses a List of Trades and queues normalisation when a run is attached", async () => {
    const runId = generateId<string>();
    const seeded = await seed("list-of-trades-comma-iso.csv", "LIST_OF_TRADES");

    const result = await handleReportParse(db, s3, bucket, {
      reportUploadId: seeded.reportUploadId,
      verificationId: seeded.verificationId,
      organisationId: seeded.organisationId,
      objectKey: seeded.objectKey,
      kind: "LIST_OF_TRADES",
      backtestRunId: runId,
    });

    expect(result).toEqual({ parseStatus: "PARSED", normalisationQueued: true });

    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, seeded.reportUploadId));
    expect(upload?.parseStatus).toBe("PARSED");
    expect(upload?.parserVersion).toBe("1.0.0");
    expect(upload?.parsedTrades).toHaveLength(3);
    // The fixture's third trade has no exit row; that warning must reach the
    // operator, not be silently dropped (CLAUDE.md 15.2).
    expect((upload?.parseWarnings as string[]).some((w) => w.includes("OPEN_POSITION_AT_END"))).toBe(true);

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, "report_upload.parsed"));
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.aggregateId).toBe(seeded.reportUploadId);
    expect(event.payload).toEqual({ backtestRunId: runId, reportUploadId: seeded.reportUploadId });
    expect(() => TradeNormalisationJob.parse(event.payload)).not.toThrow();
    expect(
      routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue,
    ).toBe(QUEUE_NAMES.tradeNormalisation);
  });

  it("does not queue normalisation without a backtestRunId", async () => {
    const seeded = await seed("list-of-trades-comma-iso.csv", "LIST_OF_TRADES");

    const result = await handleReportParse(db, s3, bucket, {
      reportUploadId: seeded.reportUploadId,
      verificationId: seeded.verificationId,
      organisationId: seeded.organisationId,
      objectKey: seeded.objectKey,
      kind: "LIST_OF_TRADES",
    });

    expect(result.normalisationQueued).toBe(false);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "report_upload.parsed"));
    expect(events).toHaveLength(0);
  });

  it("ingests a Performance Summary's metrics but never queues normalisation for it", async () => {
    const runId = generateId<string>();
    const seeded = await seed("performance-summary-comma.csv", "PERFORMANCE_SUMMARY");

    const result = await handleReportParse(db, s3, bucket, {
      reportUploadId: seeded.reportUploadId,
      verificationId: seeded.verificationId,
      organisationId: seeded.organisationId,
      objectKey: seeded.objectKey,
      kind: "PERFORMANCE_SUMMARY",
      backtestRunId: runId,
    });

    expect(result).toEqual({ parseStatus: "PARSED", normalisationQueued: false });
    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, seeded.reportUploadId));
    expect(upload?.parsedTrades).toBeNull();
    const netProfit = (upload?.parsedMetrics as Array<{ name: string; values: Record<string, number> }>).find(
      (m) => m.name === "Net Profit",
    );
    expect(netProfit?.values["All USD"]).toBeCloseTo(7.95);
  });

  it("marks an unparseable upload FAILED without losing the raw artefact reference", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status: "UPLOADED",
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });

    const garbage = "Not,A,TradingView,Export\n1,2,3,4\n";
    const bytes = new TextEncoder().encode(garbage);
    const objectKey = `test/orgs/${org.organisationId}/verifications/${verificationId}/garbage.csv`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: "text/csv" }));
    uploadedKeys.push(objectKey);

    const artefactId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId: org.organisationId,
      objectKey,
      contentType: "text/csv",
      sizeBytes: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
      kind: "tradingview_list_of_trades",
    });

    const reportUploadId = generateId<string>();
    await db.insert(reportUploads).values({
      id: reportUploadId,
      verificationId,
      kind: "LIST_OF_TRADES",
      rawArtefactId: artefactId,
      uploadedByUserId: org.userId,
    });

    const result = await handleReportParse(db, s3, bucket, {
      reportUploadId,
      verificationId,
      organisationId: org.organisationId,
      objectKey,
      kind: "LIST_OF_TRADES",
    });

    expect(result).toEqual({ parseStatus: "FAILED", normalisationQueued: false });
    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, reportUploadId));
    expect(upload?.parseStatus).toBe("FAILED");
    expect(upload?.rawArtefactId).toBe(artefactId);
    expect((upload?.parseWarnings as string[]).join(" ")).toContain("missing required columns");

    const [artefact] = await db.select().from(artefacts).where(eq(artefacts.id, artefactId));
    expect(artefact?.checksumSha256).toBe(sha256Hex(garbage));
  });
});
