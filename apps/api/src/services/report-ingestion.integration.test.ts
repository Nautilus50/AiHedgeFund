import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  type Database,
} from "@arf-os/db";
import { QUEUE_NAMES, ReportParseJob, routeOutboxEvent } from "@arf-os/event-bus";
import { createObjectStoreClient } from "./object-store.js";
import { completeReportUpload, createReportUploadIntent, createTradingViewVerification } from "./verification.js";

try {
  process.loadEnvFile();
} catch {
  // No .env — the storage guard below will skip this suite.
}

function readStorageCredentials() {
  const endpoint = process.env.OBJECT_STORE_ENDPOINT;
  const bucket = process.env.OBJECT_STORE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

const credentials = readStorageCredentials();
const dbAvailable = await isTestDatabaseAvailable();
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../pine/fixtures/tradingview");

/**
 * The MVP's core evidence chain (spec 13.2): a researcher uploads a real
 * TradingView export, and ARF-OS preserves the raw bytes by checksum before
 * anything is parsed. Exercises real R2 and real Postgres together — a mock
 * of either would hide exactly the transport and persistence faults this is
 * meant to catch.
 *
 * Parsing itself is a separate, asynchronous job (`handleReportParse` in
 * worker-backtest) — this suite only covers the API's half: durably storing
 * the upload and handing off to that job via the outbox (CLAUDE.md 16.1,
 * request handlers stay fast; the parse itself is covered by
 * `apps/worker-backtest/src/report-parse.integration.test.ts`).
 */
describe.skipIf(!credentials || !dbAvailable)("report ingestion (integration)", () => {
  let db: Database;
  let s3: S3Client;
  const uploadedKeys: string[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    if (credentials) {
      s3 = createObjectStoreClient(credentials);
    }
  });

  afterAll(async () => {
    if (credentials) {
      for (const key of uploadedKeys) {
        await s3.send(new DeleteObjectCommand({ Bucket: credentials.bucket, Key: key })).catch(() => undefined);
      }
    }
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  async function seedVerification() {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const { verificationId } = await createTradingViewVerification(db, {
      strategyVersionId: strategy.strategyVersionId,
      requiredSymbol: "BYBIT:BTCUSDT.P",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });
    return { org, strategy, verificationId };
  }

  async function uploadFixture(
    fixtureName: string,
    kind: "LIST_OF_TRADES" | "PERFORMANCE_SUMMARY",
    backtestRunId?: string,
  ) {
    if (!credentials) throw new Error("unreachable: guarded by skipIf");

    const { org, strategy, verificationId } = await seedVerification();
    const content = readFileSync(join(fixturesDir, fixtureName), "utf-8");

    const intent = await createReportUploadIntent(s3, credentials.bucket, {
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      strategyId: strategy.strategyId,
      strategyVersionId: strategy.strategyVersionId,
      verificationId,
      kind,
    });
    uploadedKeys.push(intent.objectKey);

    const put = await fetch(intent.uploadUrl, {
      method: "PUT",
      body: content,
      headers: { "Content-Type": "text/csv" },
    });
    expect(put.ok).toBe(true);

    const result = await completeReportUpload(db, s3, credentials.bucket, {
      organisationId: org.organisationId,
      verificationId,
      kind,
      objectKey: intent.objectKey,
      uploadedByUserId: org.userId,
      backtestRunId,
    });

    return { org, strategy, verificationId, content, intent, result };
  }

  it("preserves the raw upload by checksum and stores it PENDING parse", async () => {
    const { org, content, intent, result } = await uploadFixture(
      "list-of-trades-comma-iso.csv",
      "LIST_OF_TRADES",
    );

    const [artefact] = await db.select().from(artefacts).where(eq(artefacts.id, result.artefactId));
    expect(artefact?.organisationId).toBe(org.organisationId);
    expect(artefact?.objectKey).toBe(intent.objectKey);
    // The checksum is recomputed from the bytes fetched back out of R2,
    // never taken from the client (CLAUDE.md 15.1).
    expect(artefact?.checksumSha256).toBe(sha256Hex(content));
    expect(artefact?.sizeBytes).toBe(new TextEncoder().encode(content).byteLength);

    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parseStatus).toBe("PENDING");
    expect(upload?.rawArtefactId).toBe(result.artefactId);
    expect(upload?.parsedTrades).toBeNull();
  });

  it("hands off to the report-parse job with a payload the worker can consume", async () => {
    const { org, verificationId, intent, result } = await uploadFixture(
      "performance-summary-comma.csv",
      "PERFORMANCE_SUMMARY",
    );

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "report_upload.uploaded"));

    expect(event).toBeDefined();
    if (!event) return;
    expect(event.aggregateId).toBe(result.reportUploadId);

    const payload = ReportParseJob.parse(event.payload);
    expect(payload).toEqual({
      reportUploadId: result.reportUploadId,
      verificationId,
      organisationId: org.organisationId,
      objectKey: intent.objectKey,
      kind: "PERFORMANCE_SUMMARY",
    });

    // The relay must route it to the report-parse queue — assert the
    // contract here rather than only discovering a routing gap in production.
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      QUEUE_NAMES.reportParse,
    );
  });

  it("carries the backtestRunId through for a List of Trades, for later normalisation", async () => {
    const runId = generateId<string>();
    const { result } = await uploadFixture("list-of-trades-comma-iso.csv", "LIST_OF_TRADES", runId);

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, result.reportUploadId));
    const payload = ReportParseJob.parse(event?.payload);
    expect(payload.backtestRunId).toBe(runId);
  });

  it("preserves an unparseable upload too — the artefact is durable before any parse is attempted", async () => {
    if (!credentials) throw new Error("unreachable: guarded by skipIf");

    const { org, strategy, verificationId } = await seedVerification();
    const garbage = "Not,A,TradingView,Export\n1,2,3,4\n";

    const intent = await createReportUploadIntent(s3, credentials.bucket, {
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      strategyId: strategy.strategyId,
      strategyVersionId: strategy.strategyVersionId,
      verificationId,
      kind: "LIST_OF_TRADES",
    });
    uploadedKeys.push(intent.objectKey);
    await fetch(intent.uploadUrl, { method: "PUT", body: garbage, headers: { "Content-Type": "text/csv" } });

    const result = await completeReportUpload(db, s3, credentials.bucket, {
      organisationId: org.organisationId,
      verificationId,
      kind: "LIST_OF_TRADES",
      objectKey: intent.objectKey,
      uploadedByUserId: org.userId,
    });

    // Whether the content will later parse is not this function's concern —
    // it never even looks. The artefact and checksum are durable regardless
    // (CLAUDE.md 15.1); `handleReportParse` decides PARSED vs FAILED.
    const [artefact] = await db.select().from(artefacts).where(eq(artefacts.id, result.artefactId));
    expect(artefact?.checksumSha256).toBe(sha256Hex(garbage));
    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parseStatus).toBe("PENDING");
  });
});
