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
  parseOutcome: ReportParseOutcome;
  /** True when a report_upload.parsed event was emitted, i.e. normalisation will run. */
  normalisationQueued: boolean;
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

  // A Performance Summary's reported metrics are the only TradingView side
  // parity has to compare against, so they are persisted here rather than
  // returned and discarded. Stored verbatim — titles and source column
  // headers as the parser produced them, no reinterpretation (CLAUDE.md 15.2).
  const parsedMetrics =
    parseOutcome.kind === "PERFORMANCE_SUMMARY" && parseOutcome.result.ok
      ? parseOutcome.result.metrics
      : null;

  // Likewise for a trade ledger: normalisation reads this rather than
  // re-fetching and re-parsing the raw CSV, so the ledger it writes is
  // traceable to one stored parse result and one parser version.
  const parsedTrades =
    parseOutcome.kind === "LIST_OF_TRADES" && parseOutcome.result.ok ? parseOutcome.result.trades : null;

  // Only a successfully parsed ledger attached to a known run can be
  // normalised. Without both, the upload is still stored — it is evidence
  // either way — but no event is emitted, because there is nothing a
  // consumer could do with it.
  const normalisationQueued = parsedTrades !== null && input.backtestRunId !== undefined;

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
      parsedMetrics,
      parsedTrades,
      uploadedByUserId: input.uploadedByUserId,
    });

    // Transactional outbox: committed with the rows it describes, so the
    // event cannot exist without the upload nor be lost after it
    // (CLAUDE.md 9.3). The relay routes it to trade normalisation.
    if (normalisationQueued) {
      const now = new Date();
      await tx.insert(outboxEvents).values({
        id: generateId<string>(),
        eventType: "report_upload.parsed",
        eventVersion: "1.0.0",
        aggregateId: reportUploadId,
        aggregateVersion: now.getTime().toString(),
        correlationId: generateId<string>(),
        actor: input.uploadedByUserId,
        // TradeNormalisationJob's exact shape.
        payload: { backtestRunId: input.backtestRunId, reportUploadId },
        createdAt: now,
      });
    }
  });

  return { artefactId, reportUploadId, parseOutcome, normalisationQueued };
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
