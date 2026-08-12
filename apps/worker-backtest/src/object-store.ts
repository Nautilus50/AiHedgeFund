import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ObjectStoreConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | undefined;
}

/** Cloudflare R2's documented aws-sdk-v3 configuration — region "auto", no forcePathStyle. Mirrors apps/api's object-store client (small, deliberate per-app duplication — no shared object-storage package in CLAUDE.md's layout). */
export function createObjectStoreClient(config: ObjectStoreConfig): S3Client {
  return new S3Client({
    region: config.region ?? "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/** Fetches an object's raw bytes as UTF-8 text — this app only ever reads CSV datasets back. */
export async function fetchObjectText(client: S3Client, bucket: string, objectKey: string): Promise<string> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  const text = await result.Body?.transformToString("utf-8");
  if (text === undefined) {
    throw new Error(`Object ${objectKey} has no body.`);
  }
  return text;
}
