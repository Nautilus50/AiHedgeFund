import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { artefacts, closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, truncateAll, type Database } from "@arf-os/db";
import { buildArtefactKey, createObjectStoreClient, createPresignedUploadUrl, objectExists } from "./object-store.js";
import { findAbandonedUploads, reapAbandonedUploads } from "./upload-reaping.js";

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
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

const credentials = readCredentials();
const dbAvailable = await isTestDatabaseAvailable();
const available = dbAvailable && credentials !== undefined;

/**
 * Real R2 + real Postgres, not mocks — the whole point of this feature is
 * cross-referencing what's actually in the bucket against what the
 * database actually knows about, so a mock of either side would prove
 * nothing. `graceMs` is passed explicitly rather than waiting real wall
 * clock time: 0 makes "just uploaded" already abandoned, a large value
 * keeps it safely within the grace window — both deterministic.
 */
describe.skipIf(!available)("upload reaping (live R2 + Postgres integration)", () => {
  let db: Database;
  const bucket = credentials?.bucket ?? "";
  let client: ReturnType<typeof createObjectStoreClient>;
  const uploadedKeys: string[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    if (!credentials) throw new Error("unreachable: describe.skipIf already guarded this");
    client = createObjectStoreClient(credentials);
  });

  afterAll(async () => {
    await closeDatabase(db);
    while (uploadedKeys.length > 0) {
      const key = uploadedKeys.pop();
      if (key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    }
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  async function uploadProbe(organisationId: string, filename: string): Promise<string> {
    const objectKey = buildArtefactKey({
      organisationId,
      campaignId: "camp",
      strategyId: "strat",
      strategyVersionId: "v1",
      category: "tradingview-verification",
      categoryId: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename,
    });

    const { uploadUrl } = await createPresignedUploadUrl(client, bucket, objectKey, { contentType: "text/plain" });
    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: "abandoned upload probe\n",
      headers: { "Content-Type": "text/plain" },
    });
    if (!putResponse.ok) throw new Error(`Probe upload failed: ${putResponse.status}`);

    uploadedKeys.push(objectKey);
    return objectKey;
  }

  it("flags an object with no matching artefacts row, past the grace period", async () => {
    const org = await seedOrganisation(db);
    const objectKey = await uploadProbe(org.organisationId, "abandoned.txt");

    const found = await findAbandonedUploads(client, bucket, db, org.organisationId, 0);
    expect(found.map((f) => f.objectKey)).toContain(objectKey);
  }, 20_000);

  it("never flags an object still within the grace period", async () => {
    const org = await seedOrganisation(db);
    await uploadProbe(org.organisationId, "fresh.txt");

    const found = await findAbandonedUploads(client, bucket, db, org.organisationId, 60 * 60 * 1000);
    expect(found).toEqual([]);
  }, 20_000);

  it("never flags an object that has a matching artefacts row, even past the grace period", async () => {
    const org = await seedOrganisation(db);
    const objectKey = await uploadProbe(org.organisationId, "completed.txt");

    await db.insert(artefacts).values({
      id: generateId<string>(),
      organisationId: org.organisationId,
      objectKey,
      contentType: "text/plain",
      sizeBytes: 10,
      checksumSha256: "deadbeef",
      kind: "tradingview_list_of_trades",
    });

    const found = await findAbandonedUploads(client, bucket, db, org.organisationId, 0);
    expect(found.map((f) => f.objectKey)).not.toContain(objectKey);
  }, 20_000);

  it("never returns another organisation's abandoned objects", async () => {
    const orgA = await seedOrganisation(db, { slug: "reap-org-a" });
    const orgB = await seedOrganisation(db, { slug: "reap-org-b" });
    await uploadProbe(orgB.organisationId, "other-org.txt");

    const found = await findAbandonedUploads(client, bucket, db, orgA.organisationId, 0);
    expect(found).toEqual([]);
  }, 20_000);

  it("actually deletes the flagged objects and reports what it freed", async () => {
    const org = await seedOrganisation(db);
    const objectKey = await uploadProbe(org.organisationId, "to-delete.txt");

    const result = await reapAbandonedUploads(client, bucket, db, org.organisationId, 0);

    expect(result.deleted).toContain(objectKey);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(await objectExists(client, bucket, objectKey)).toBe(false);

    // Already deleted — don't try to clean it up again in afterAll.
    const index = uploadedKeys.indexOf(objectKey);
    if (index !== -1) uploadedKeys.splice(index, 1);
  }, 20_000);
});
