import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "@arf-os/contracts";
import { describe, expect, it } from "vitest";
import {
  buildArtefactKey,
  createObjectStoreClient,
  createPresignedUploadUrl,
  objectExists,
  verifyUploadedObject,
} from "./object-store.js";

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

/**
 * Genuine round-trip against the real R2 bucket, not a mock — Milestone 7
 * was unblocked specifically by getting live credentials, so this proves
 * the presigned-upload + independent-checksum-verification flow actually
 * works end to end. Skipped automatically wherever OBJECT_STORE_* env vars
 * are absent (CI, other machines) rather than failing the suite.
 */
describe.skipIf(!credentials)("object store (live R2 integration)", () => {
  it("presigns an upload, uploads via the URL, and independently verifies the checksum", async () => {
    if (!credentials) {
      throw new Error("unreachable: describe.skipIf already guarded this");
    }
    const { endpoint, bucket, accessKeyId, secretAccessKey } = credentials;

    const client = createObjectStoreClient({ endpoint, bucket, accessKeyId, secretAccessKey });

    const objectKey = buildArtefactKey({
      organisationId: "milestone-7-live-test",
      campaignId: "camp",
      strategyId: "strat",
      strategyVersionId: "v1",
      category: "tradingview-verification",
      categoryId: `run-${Date.now()}`,
      filename: "probe.txt",
    });

    const content = `arf-os milestone 7 live test — ${new Date().toISOString()}\n`;

    try {
      const { uploadUrl } = await createPresignedUploadUrl(client, bucket, objectKey, {
        contentType: "text/plain",
      });

      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        body: content,
        headers: { "Content-Type": "text/plain" },
      });
      expect(putResponse.ok).toBe(true);

      expect(await objectExists(client, bucket, objectKey)).toBe(true);

      const info = await verifyUploadedObject(client, bucket, objectKey);
      expect(info.checksumSha256).toBe(sha256Hex(content));
      expect(info.sizeBytes).toBe(new TextEncoder().encode(content).byteLength);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      expect(await objectExists(client, bucket, objectKey)).toBe(false);
    }
  });
});
