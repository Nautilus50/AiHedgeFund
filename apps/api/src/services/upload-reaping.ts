import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { artefacts } from "@arf-os/db";

/**
 * Grace period before an object with no `artefacts` row is considered
 * abandoned rather than mid-flight. Generous relative to the presigned
 * upload URL's own 15-minute expiry (`createPresignedUploadUrl`) — this
 * exists to survive a slow or retried client, not to catch one quickly.
 */
export const DEFAULT_REAP_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface AbandonedObject {
  objectKey: string;
  lastModified: Date;
  sizeBytes: number;
}

async function listAllObjects(s3: S3Client, bucket: string, prefix: string) {
  const objects: { key: string; lastModified: Date; size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified) {
        objects.push({ key: object.Key, lastModified: object.LastModified, size: object.Size ?? 0 });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * A presigned upload URL (CLAUDE.md 15.1) creates no database row —
 * `completeReportUpload` does, once it re-fetches and checksums the bytes.
 * A client that uploads but never calls complete (crash, abandoned tab,
 * network drop after the PUT) leaves a real object in the bucket with
 * nothing pointing at it. `artefacts.object_key` is the exact set of
 * objects anything in this system actually knows about, so anything under
 * this organisation's prefix that isn't in that set — and old enough not
 * to just be mid-flight — is genuinely orphaned.
 *
 * Read-only: identifies candidates without touching storage. Kept separate
 * from {@link reapAbandonedUploads} so an operator can review before
 * deleting anything (this repo has no scheduled-job mechanism to run
 * either automatically yet — CLAUDE.md 3.8's spirit against building ahead
 * of what's needed applies here too; see the ADR).
 */
export async function findAbandonedUploads(
  s3: S3Client,
  bucket: string,
  db: Database,
  organisationId: string,
  graceMs: number = DEFAULT_REAP_GRACE_PERIOD_MS,
): Promise<AbandonedObject[]> {
  const prefix = `orgs/${organisationId}/`;
  const cutoff = new Date(Date.now() - graceMs);

  const [objects, known] = await Promise.all([
    listAllObjects(s3, bucket, prefix),
    db.select({ objectKey: artefacts.objectKey }).from(artefacts).where(eq(artefacts.organisationId, organisationId)),
  ]);

  const knownKeys = new Set(known.map((row) => row.objectKey));

  return objects
    .filter((object) => !knownKeys.has(object.key) && object.lastModified < cutoff)
    .map((object) => ({ objectKey: object.key, lastModified: object.lastModified, sizeBytes: object.size }));
}

export interface ReapResult {
  deleted: string[];
  bytesFreed: number;
}

/**
 * Deletes every object {@link findAbandonedUploads} identifies. Genuinely
 * destructive and irreversible — call only from an explicit operator
 * action (a script, an admin-only route), never a background timer this
 * repo doesn't have a mechanism for yet.
 */
export async function reapAbandonedUploads(
  s3: S3Client,
  bucket: string,
  db: Database,
  organisationId: string,
  graceMs: number = DEFAULT_REAP_GRACE_PERIOD_MS,
): Promise<ReapResult> {
  const candidates = await findAbandonedUploads(s3, bucket, db, organisationId, graceMs);

  for (const candidate of candidates) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: candidate.objectKey }));
  }

  return {
    deleted: candidates.map((c) => c.objectKey),
    bytesFreed: candidates.reduce((sum, c) => sum + c.sizeBytes, 0),
  };
}
