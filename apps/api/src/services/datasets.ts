import type { S3Client } from "@aws-sdk/client-s3";
import { generateId, sha256Hex } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { artefacts, datasetVersions } from "@arf-os/db";
import { parseOhlcvCsv } from "@arf-os/pine";
import { buildDatasetKey, putObject } from "./object-store.js";

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
