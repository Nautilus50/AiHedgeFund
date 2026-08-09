import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@arf-os/contracts";
import {
  artefacts,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { createObjectStoreClient } from "./object-store.js";
import {
  completeReportUpload,
  createReportUploadIntent,
  createTradingViewVerification,
  getReportUploadsForVerification,
} from "./verification.js";

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
 * TradingView export, and ARF-OS preserves the raw bytes by checksum and
 * parses them into structured trades. Exercises real R2 and real Postgres
 * together — a mock of either would hide exactly the transport and
 * persistence faults this is meant to catch.
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

  async function uploadFixture(fixtureName: string, kind: "LIST_OF_TRADES" | "PERFORMANCE_SUMMARY") {
    if (!credentials) throw new Error("unreachable: guarded by skipIf");

    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const { verificationId } = await createTradingViewVerification(db, {
      strategyVersionId: strategy.strategyVersionId,
      requiredSymbol: "BYBIT:BTCUSDT.P",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });

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
    });

    return { org, strategy, verificationId, content, intent, result };
  }

  it("preserves the raw upload by checksum and parses it into trades", async () => {
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
    expect(upload?.parseStatus).toBe("PARSED");
    expect(upload?.rawArtefactId).toBe(result.artefactId);
    expect(upload?.parserVersion).toBe("1.0.0");

    expect(result.parseOutcome.kind).toBe("LIST_OF_TRADES");
    if (result.parseOutcome.kind === "LIST_OF_TRADES" && result.parseOutcome.result.ok) {
      expect(result.parseOutcome.result.trades).toHaveLength(3);
    }
  });

  it("surfaces parser warnings on the upload row rather than discarding them", async () => {
    const { verificationId } = await uploadFixture("list-of-trades-comma-iso.csv", "LIST_OF_TRADES");

    const uploads = await getReportUploadsForVerification(db, verificationId);
    expect(uploads).toHaveLength(1);
    // The fixture's third trade has no exit row; that warning must reach the
    // operator, not be silently dropped (CLAUDE.md 15.2).
    expect(uploads[0]?.parseWarnings.some((w) => w.includes("OPEN_POSITION_AT_END"))).toBe(true);
  });

  it("ingests a Performance Summary export alongside the trade list", async () => {
    const { result } = await uploadFixture("performance-summary-comma.csv", "PERFORMANCE_SUMMARY");

    expect(result.parseOutcome.kind).toBe("PERFORMANCE_SUMMARY");
    if (result.parseOutcome.kind === "PERFORMANCE_SUMMARY" && result.parseOutcome.result.ok) {
      const netProfit = result.parseOutcome.result.metrics.find((m) => m.name === "Net Profit");
      expect(netProfit?.values["All USD"]).toBeCloseTo(7.95);
    }
  });

  it("still preserves the raw artefact when the file fails to parse", async () => {
    if (!credentials) throw new Error("unreachable: guarded by skipIf");

    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);
    const { verificationId } = await createTradingViewVerification(db, {
      strategyVersionId: strategy.strategyVersionId,
      requiredSymbol: "BYBIT:BTCUSDT.P",
      requiredTimeframe: "60",
      requestedByUserId: org.userId,
    });

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

    const [upload] = await db.select().from(reportUploads).where(eq(reportUploads.id, result.reportUploadId));
    expect(upload?.parseStatus).toBe("FAILED");
    expect(upload?.parseWarnings.join(" ")).toContain("missing required columns");

    // A rejected parse must never cost us the evidence: the raw artefact and
    // its checksum are still recorded (CLAUDE.md 15.2 — "preserve raw upload").
    const [artefact] = await db.select().from(artefacts).where(eq(artefacts.id, result.artefactId));
    expect(artefact?.checksumSha256).toBe(sha256Hex(garbage));
  });
});
