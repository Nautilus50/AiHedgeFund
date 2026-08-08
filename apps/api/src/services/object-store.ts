import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sha256Hex } from "@arf-os/contracts";

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** Cloudflare R2's documented aws-sdk-v3 configuration — region "auto", no forcePathStyle. */
export function createObjectStoreClient(config: ObjectStoreConfig): S3Client {
  return new S3Client({
    region: config.region ?? "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export type ArtefactCategory = "tradingview-verification" | "backtests" | "forward" | "decisions";

export interface ArtefactKeyInput {
  organisationId: string;
  campaignId: string;
  strategyId: string;
  strategyVersionId: string;
  category: ArtefactCategory;
  categoryId: string;
  filename: string;
}

/**
 * Canonical object-store key layout (spec 14.7). Pure — no network — so the
 * path convention can be unit-tested without touching R2.
 */
export function buildArtefactKey(input: ArtefactKeyInput): string {
  return [
    "orgs",
    input.organisationId,
    "campaigns",
    input.campaignId,
    "strategies",
    input.strategyId,
    "versions",
    input.strategyVersionId,
    input.category,
    input.categoryId,
    input.filename,
  ].join("/");
}

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresInSeconds: number;
}

/**
 * Presigned PUT URL — the client (browser or CLI) uploads directly to the
 * object store; our API never proxies the file bytes (CLAUDE.md 15.1 —
 * "Use presigned object-store uploads").
 */
export async function createPresignedUploadUrl(
  client: S3Client,
  bucket: string,
  objectKey: string,
  options: { contentType: string; expiresInSeconds?: number },
): Promise<PresignedUpload> {
  const expiresInSeconds = options.expiresInSeconds ?? 900;
  const command = new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: options.contentType });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return { uploadUrl, objectKey, expiresInSeconds };
}

export interface FetchedObject {
  bytes: Uint8Array;
  contentType: string | undefined;
}

/** Fetches an object's raw bytes. The single source of truth other helpers (and report parsing) build on. */
export async function fetchObject(client: S3Client, bucket: string, objectKey: string): Promise<FetchedObject> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`Object ${objectKey} has no body.`);
  }
  return { bytes, contentType: result.ContentType };
}

export interface UploadedObjectInfo {
  sizeBytes: number;
  checksumSha256: string;
  contentType: string | undefined;
}

/**
 * Fetches an uploaded object back and independently recomputes its SHA-256
 * checksum — never trusts a client-reported checksum or size
 * (CLAUDE.md 15.1: preserve raw uploaded evidence by checksum).
 */
export async function verifyUploadedObject(
  client: S3Client,
  bucket: string,
  objectKey: string,
): Promise<UploadedObjectInfo> {
  const { bytes, contentType } = await fetchObject(client, bucket, objectKey);
  return { sizeBytes: bytes.byteLength, checksumSha256: sha256Hex(bytes), contentType };
}

export async function objectExists(client: S3Client, bucket: string, objectKey: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}
