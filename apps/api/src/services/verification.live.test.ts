import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { parseListOfTrades } from "@arf-os/pine";
import { describe, expect, it } from "vitest";
import { createObjectStoreClient, fetchObject } from "./object-store.js";
import { createReportUploadIntent } from "./verification.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — hasCredentials below will be false and this suite is skipped.
}

function readCredentials():
  | { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
  | undefined {
  const endpoint = process.env.OBJECT_STORE_ENDPOINT;
  const bucket = process.env.OBJECT_STORE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORE_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return undefined;
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

const credentials = readCredentials();
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../pine/fixtures/tradingview");

/**
 * Uploads a real TradingView "List of Trades" fixture through the actual
 * presigned-upload flow, fetches it back from R2, and confirms the
 * Milestone 8 parser produces identical results before and after the
 * round-trip — catches any encoding/transport corruption a mocked test
 * would miss (DB persistence itself still needs Milestone 13's Postgres).
 */
describe.skipIf(!credentials)("report upload (live R2 integration)", () => {
  it("round-trips a real List of Trades fixture through R2 without altering its parsed content", async () => {
    if (!credentials) {
      throw new Error("unreachable: describe.skipIf already guarded this");
    }
    const { endpoint, bucket, accessKeyId, secretAccessKey } = credentials;

    const s3 = createObjectStoreClient({ endpoint, bucket, accessKeyId, secretAccessKey });
    const originalText = readFileSync(join(fixturesDir, "list-of-trades-comma-iso.csv"), "utf-8");

    const { uploadUrl, objectKey } = await createReportUploadIntent(s3, bucket, {
      organisationId: "milestone-7-live-test",
      campaignId: "camp",
      strategyId: "strat",
      strategyVersionId: "v1",
      verificationId: `run-${Date.now()}`,
      kind: "LIST_OF_TRADES",
    });

    try {
      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        body: originalText,
        headers: { "Content-Type": "text/csv" },
      });
      expect(putResponse.ok).toBe(true);

      const { bytes } = await fetchObject(s3, bucket, objectKey);
      const roundTrippedText = new TextDecoder().decode(bytes);

      const originalParse = parseListOfTrades(originalText);
      const roundTrippedParse = parseListOfTrades(roundTrippedText);

      expect(roundTrippedParse).toEqual(originalParse);
      if (roundTrippedParse.ok) {
        expect(roundTrippedParse.trades).toHaveLength(3);
      }
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    }
  });
});
