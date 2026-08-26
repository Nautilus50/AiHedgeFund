import type { S3Client } from "@aws-sdk/client-s3";
import { and, eq, gt, or } from "drizzle-orm";
import { generateId, sha256Hex } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { artefacts, datasetVersions } from "@arf-os/db";
import { parseOhlcvCsv, type Bar } from "@arf-os/pine";
import { buildPage, clampPageSize, decodeCursor, type Page } from "../lib/pagination.js";
import { buildDatasetKey, fetchObject, putObject } from "./object-store.js";

/**
 * Looks up a `dataset_versions` row that already covers the exact same
 * symbol/timeframe/date-range for this organisation, so a re-run of the
 * same ingest command (e.g. `ingest-ohlcv.ts`) skips re-inserting an
 * identical immutable dataset version rather than accumulating duplicates.
 * A different date range for the same symbol/timeframe is *not* a match —
 * that's a genuinely different dataset and gets its own version.
 */
export async function findMatchingDatasetVersion(
  db: Database,
  organisationId: string,
  symbol: string,
  timeframe: string,
  fromTs: Date,
  toTs: Date,
): Promise<{ datasetVersionId: string } | undefined> {
  const [row] = await db
    .select({ id: datasetVersions.id })
    .from(datasetVersions)
    .where(
      and(
        eq(datasetVersions.organisationId, organisationId),
        eq(datasetVersions.symbol, symbol),
        eq(datasetVersions.timeframe, timeframe),
        eq(datasetVersions.fromTs, fromTs),
        eq(datasetVersions.toTs, toTs),
      ),
    )
    .limit(1);

  return row ? { datasetVersionId: row.id } : undefined;
}

export interface CreateDatasetVersionInput {
  organisationId: string;
  symbol: string;
  timeframe: string;
  filename: string;
  csv: string;
}

/**
 * Seeds one dataset version from an OHLCV CSV already held in-process — a
 * fixture for tests/dev seeding, not a public ingestion API (that's real
 * future scope; CLAUDE.md 3.8: don't build ahead of what's needed).
 *
 * `barCount`/`fromTs`/`toTs` are derived from the parsed bars, not taken on
 * faith from the caller, mirroring {@link verifyUploadedObject}'s
 * independent-recomputation pattern (CLAUDE.md 15.1).
 */
export async function createDatasetVersion(
  db: Database,
  s3: S3Client,
  bucket: string,
  input: CreateDatasetVersionInput,
): Promise<{ datasetVersionId: string }> {
  const parsed = parseOhlcvCsv(input.csv);
  if (!parsed.ok) {
    throw new Error(`Dataset CSV failed to parse: ${parsed.message}`);
  }
  if (parsed.bars.length === 0) {
    throw new Error("Dataset CSV parsed to zero bars.");
  }

  const firstBar = parsed.bars[0];
  const lastBar = parsed.bars[parsed.bars.length - 1];
  if (firstBar === undefined || lastBar === undefined) {
    throw new Error("Dataset CSV parsed to zero bars.");
  }

  const bytes = new TextEncoder().encode(input.csv);
  const checksumSha256 = sha256Hex(bytes);
  const datasetVersionId = generateId<string>();
  const artefactId = generateId<string>();
  const objectKey = buildDatasetKey({ organisationId: input.organisationId, datasetVersionId, filename: input.filename });

  await putObject(s3, bucket, objectKey, bytes, "text/csv");

  await db.transaction(async (tx) => {
    await tx.insert(artefacts).values({
      id: artefactId,
      organisationId: input.organisationId,
      objectKey,
      contentType: "text/csv",
      sizeBytes: bytes.byteLength,
      checksumSha256,
      kind: "ohlcv_dataset",
    });

    await tx.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId: input.organisationId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      fromTs: new Date(firstBar.time),
      toTs: new Date(lastBar.time),
      barCount: parsed.bars.length,
      checksumSha256,
      artefactId,
    });
  });

  return { datasetVersionId };
}

/**
 * Reads a dataset version's bars back out of object storage — the read
 * side of {@link createDatasetVersion}, needed by Validation Lab's
 * benchmark-comparison panel (ADR 0009) to source real buy-and-hold prices.
 * Organisation-scoped through the same `dataset_versions` row a
 * `backtest_runs.dataset_version_id` points at; returns undefined for a
 * missing/foreign dataset version or a CSV that fails to parse, rather than
 * throwing — the caller treats either as "no benchmark data available",
 * never a hard failure of the report around it.
 */
export async function loadDatasetBars(
  db: Database,
  s3: S3Client,
  bucket: string,
  organisationId: string,
  datasetVersionId: string,
): Promise<Bar[] | undefined> {
  const [row] = await db
    .select({ objectKey: artefacts.objectKey })
    .from(datasetVersions)
    .innerJoin(artefacts, eq(artefacts.id, datasetVersions.artefactId))
    .where(and(eq(datasetVersions.id, datasetVersionId), eq(datasetVersions.organisationId, organisationId)))
    .limit(1);

  if (!row) return undefined;

  const { bytes } = await fetchObject(s3, bucket, row.objectKey);
  const parsed = parseOhlcvCsv(new TextDecoder().decode(bytes));
  if (!parsed.ok) return undefined;

  return parsed.bars;
}

export interface ListDatasetVersionsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type ListDatasetVersionsResult =
  | {
      ok: true;
      page: Page<{
        id: string;
        symbol: string;
        timeframe: string;
        fromTs: Date;
        toTs: Date;
        barCount: number;
        createdAt: Date;
      }>;
    }
  | { ok: false; reasonCode: "INVALID_CURSOR" };

/**
 * Org-scoped list backing the Backtest Lab's dataset picker — the only way
 * a researcher can see what's available to launch a LOCAL_RUNNER run
 * against, short of asking someone to read the database directly.
 */
export async function listDatasetVersions(
  db: Database,
  organisationId: string,
  input: ListDatasetVersionsInput,
): Promise<ListDatasetVersionsResult> {
  const limit = clampPageSize(input.limit);

  let cursorClause;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) {
      return { ok: false, reasonCode: "INVALID_CURSOR" };
    }
    const { createdAtIso, id } = decoded.cursor;
    const createdAtDate = new Date(createdAtIso);
    cursorClause = or(
      gt(datasetVersions.createdAt, createdAtDate),
      and(eq(datasetVersions.createdAt, createdAtDate), gt(datasetVersions.id, id)),
    );
  }

  const baseClause = eq(datasetVersions.organisationId, organisationId);

  const rows = await db
    .select({
      id: datasetVersions.id,
      symbol: datasetVersions.symbol,
      timeframe: datasetVersions.timeframe,
      fromTs: datasetVersions.fromTs,
      toTs: datasetVersions.toTs,
      barCount: datasetVersions.barCount,
      createdAt: datasetVersions.createdAt,
    })
    .from(datasetVersions)
    .where(cursorClause ? and(baseClause, cursorClause) : baseClause)
    .orderBy(datasetVersions.createdAt, datasetVersions.id)
    .limit(limit + 1);

  return { ok: true, page: buildPage(rows, limit) };
}
