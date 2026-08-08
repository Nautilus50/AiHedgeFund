import type { S3Client } from "@aws-sdk/client-s3";
import { generateId, sha256Hex } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { artefacts, reportUploads, tradingviewVerifications } from "@arf-os/db";
import { parseListOfTrades, parsePerformanceSummary } from "@arf-os/pine";
import type { ListOfTradesParseResult, PerformanceSummaryParseResult, TradingViewParseFailure } from "@arf-os/pine";
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

export type ReportParseOutcome =
  | { kind: "LIST_OF_TRADES"; result: ListOfTradesParseResult | TradingViewParseFailure }
  | { kind: "PERFORMANCE_SUMMARY"; result: PerformanceSummaryParseResult | TradingViewParseFailure };

export interface CompleteUploadInput {
  organisationId: string;
  verificationId: string;
  kind: ReportKind;
  objectKey: string;
  uploadedByUserId: string;
}

export interface CompleteUploadResult {
  artefactId: string;
  reportUploadId: string;
  parseOutcome: ReportParseOutcome;
}

/**
 * Step 2 of upload: fetch the object back from R2, independently compute
 * its checksum, persist the raw artefact + report_upload row, then attempt
 * to parse it. The raw artefact and its checksum are always preserved even
 * when parsing fails — CLAUDE.md 15.1 never discards a raw upload because
 * the parser rejected it; the parse failure becomes a warning, not data loss.
 */
export async function completeReportUpload(
  db: Database,
  s3: S3Client,
  bucket: string,
  input: CompleteUploadInput,
): Promise<CompleteUploadResult> {
  const { bytes, contentType } = await fetchObject(s3, bucket, input.objectKey);
  const checksumSha256 = sha256Hex(bytes);
  const text = new TextDecoder().decode(bytes);

  const artefactId = generateId<string>();
  const reportUploadId = generateId<string>();

  const parseOutcome: ReportParseOutcome =
    input.kind === "LIST_OF_TRADES"
      ? { kind: "LIST_OF_TRADES", result: parseListOfTrades(text) }
      : { kind: "PERFORMANCE_SUMMARY", result: parsePerformanceSummary(text) };

  const parseStatus = parseOutcome.result.ok ? "PARSED" : "FAILED";
  const parserVersion = parseOutcome.result.ok ? parseOutcome.result.parserVersion : undefined;
  const parseWarnings = parseOutcome.result.ok
    ? parseOutcome.result.warnings.map((w) => `${w.code}: ${w.message}`)
    : [parseOutcome.result.message];

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
      parseStatus,
      parserVersion,
      parseWarnings,
      uploadedByUserId: input.uploadedByUserId,
    });
  });

  return { artefactId, reportUploadId, parseOutcome };
}
