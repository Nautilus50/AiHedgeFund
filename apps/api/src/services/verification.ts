import type { S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { generateId, sha256Hex } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  artefacts,
  outboxEvents,
  reportUploads,
  strategies,
  strategyVersions,
  tradingviewVerifications,
} from "@arf-os/db";
import {
  buildArtefactKey,
  createPresignedUploadUrl,
  fetchObject,
  type PresignedUpload,
} from "./object-store.js";

export type ReportKind = "PERFORMANCE_SUMMARY" | "LIST_OF_TRADES";

const FILENAME_BY_KIND: Record<ReportKind, string> = {
  PERFORMANCE_SUMMARY: "performance-summary.csv",
  LIST_OF_TRADES: "list-of-trades.csv",
};

export interface CreateVerificationInput {
  strategyVersionId: string;
  requiredSymbol: string;
  requiredTimeframe: string;
  requestedByUserId: string;
}

/** Creates the MVP TradingView verification task a researcher works through (spec 13.2). */
export async function createTradingViewVerification(
  db: Database,
  input: CreateVerificationInput,
): Promise<{ verificationId: string }> {
  const verificationId = generateId<string>();

  await db.insert(tradingviewVerifications).values({
    id: verificationId,
    strategyVersionId: input.strategyVersionId,
    status: "PENDING",
    requiredSymbol: input.requiredSymbol,
    requiredTimeframe: input.requiredTimeframe,
    requestedByUserId: input.requestedByUserId,
  });

  return { verificationId };
}

export interface UploadIntentInput {
  organisationId: string;
  campaignId: string;
  strategyId: string;
  strategyVersionId: string;
  verificationId: string;
  kind: ReportKind;
}

/**
 * Step 1 of upload: hand the client a presigned PUT URL. No database row is
 * created yet — we don't know the file's checksum or size until it's
 * actually uploaded, and CLAUDE.md 15.1 requires validating those, not
 * trusting a client-declared value.
 */
export async function createReportUploadIntent(
  s3: S3Client,
  bucket: string,
  input: UploadIntentInput,
): Promise<PresignedUpload> {
  const objectKey = buildArtefactKey({
    organisationId: input.organisationId,
    campaignId: input.campaignId,
    strategyId: input.strategyId,
    strategyVersionId: input.strategyVersionId,
    category: "tradingview-verification",
    categoryId: input.verificationId,
    filename: FILENAME_BY_KIND[input.kind],
  });

  return createPresignedUploadUrl(s3, bucket, objectKey, { contentType: "text/csv" });
}

export interface CompleteUploadInput {
  organisationId: string;
  verificationId: string;
  kind: ReportKind;
  objectKey: string;
  uploadedByUserId: string;
  /**
   * The run this ledger belongs to. Optional, and only meaningful for a
   * List of Trades: supplying it is what starts normalisation, because a
   * trade row cannot exist without the run whose identity it was produced
   * under. The caller must have already verified the run's organisation.
   */
  backtestRunId?: string | undefined;
}

export interface CompleteUploadResult {
  artefactId: string;
  reportUploadId: string;
}

/**
 * Step 2 of upload: fetch the object back from R2, independently compute
 * its checksum, persist the raw artefact + a PENDING report_upload row, then
 * emit an outbox event so a worker parses it asynchronously. This request
 * handler stays fast (CLAUDE.md 16.1) — parsing runs as its own job
 * (`handleReportParse`), not synchronously here. The raw artefact and its
 * checksum are always durable before parsing is even attempted, so a failed
 * or slow parse never risks the upload itself (CLAUDE.md 15.1).
 */
export async function completeReportUpload(
  db: Database,
  s3: S3Client,
  bucket: string,
  input: CompleteUploadInput,
): Promise<CompleteUploadResult> {
  const { bytes, contentType } = await fetchObject(s3, bucket, input.objectKey);
  const checksumSha256 = sha256Hex(bytes);

  const artefactId = generateId<string>();
  const reportUploadId = generateId<string>();

  await db.transaction(async (tx) => {
    await tx.insert(artefacts).values({
      id: artefactId,
      organisationId: input.organisationId,
      objectKey: input.objectKey,
      contentType: contentType ?? "text/csv",
      sizeBytes: bytes.byteLength,
      checksumSha256,
      kind: `tradingview_${input.kind.toLowerCase()}`,
    });

    await tx.insert(reportUploads).values({
      id: reportUploadId,
      verificationId: input.verificationId,
      kind: input.kind,
      rawArtefactId: artefactId,
      uploadedByUserId: input.uploadedByUserId,
      // parseStatus defaults to PENDING; the report-parse worker moves it to
      // PARSED/FAILED once it processes the job below.
    });

    // Transactional outbox: committed with the rows it describes, so the
    // event cannot exist without the upload nor be lost after it
    // (CLAUDE.md 9.3). The relay routes it to the report-parse queue.
    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "report_upload.uploaded",
      eventVersion: "1.0.0",
      aggregateId: reportUploadId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      actor: input.uploadedByUserId,
      // ReportParseJob's exact shape.
      payload: {
        reportUploadId,
        verificationId: input.verificationId,
        organisationId: input.organisationId,
        objectKey: input.objectKey,
        kind: input.kind,
        backtestRunId: input.backtestRunId,
      },
      createdAt: now,
    });
  });

  return { artefactId, reportUploadId };
}

/**
 * Organisation-scoped fetch, joined through strategy_versions/strategies
 * (CLAUDE.md 19.1). Also returns strategyId/campaignId/organisationId so
 * callers (e.g. the upload-intent route) can build an object-store key
 * without ever trusting a client-supplied ownership field.
 */
export async function getVerification(db: Database, organisationId: string, verificationId: string) {
  const [row] = await db
    .select({
      id: tradingviewVerifications.id,
      strategyVersionId: tradingviewVerifications.strategyVersionId,
      strategyId: strategyVersions.strategyId,
      campaignId: strategies.campaignId,
      organisationId: strategies.organisationId,
      status: tradingviewVerifications.status,
      requiredSymbol: tradingviewVerifications.requiredSymbol,
      requiredTimeframe: tradingviewVerifications.requiredTimeframe,
      requestedByUserId: tradingviewVerifications.requestedByUserId,
      createdAt: tradingviewVerifications.createdAt,
      completedAt: tradingviewVerifications.completedAt,
    })
    .from(tradingviewVerifications)
    .innerJoin(strategyVersions, eq(strategyVersions.id, tradingviewVerifications.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(tradingviewVerifications.id, verificationId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  return row;
}

export async function getReportUploadsForVerification(db: Database, verificationId: string) {
  return db.select().from(reportUploads).where(eq(reportUploads.verificationId, verificationId));
}
