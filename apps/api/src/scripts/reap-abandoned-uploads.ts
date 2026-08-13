import { createDatabase, organisations } from "@arf-os/db";
import { createObjectStoreClient } from "../services/object-store.js";
import { findAbandonedUploads, reapAbandonedUploads } from "../services/upload-reaping.js";

/**
 * Operator-run maintenance script for CLAUDE.md's "abandoned uploads are
 * not reaped" gap — this repo has no scheduled-job mechanism yet (see ADR
 * 0006/0007's precedent against inventing one ahead of need), so this is
 * meant to be wired to whatever the deployment platform's own scheduler is
 * (a Railway cron service, a GitHub Actions schedule, etc.), not run by
 * anything inside this codebase automatically.
 *
 * Usage:
 *   tsx src/scripts/reap-abandoned-uploads.ts [organisationId] [--dry-run]
 *
 * With no organisationId, sweeps every organisation. --dry-run reports
 * candidates without deleting anything.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const organisationIdArg = args.find((arg) => !arg.startsWith("--"));

  const db = createDatabase(requireEnv("DATABASE_URL"));
  const bucket = requireEnv("OBJECT_STORE_BUCKET");
  const s3 = createObjectStoreClient({
    endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
    bucket,
    accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    region: process.env.OBJECT_STORE_REGION,
  });

  const targetOrgIds = organisationIdArg
    ? [organisationIdArg]
    : (await db.select({ id: organisations.id }).from(organisations)).map((row) => row.id);

  for (const organisationId of targetOrgIds) {
    if (dryRun) {
      const candidates = await findAbandonedUploads(s3, bucket, db, organisationId);
      console.log(`[${organisationId}] ${candidates.length} abandoned object(s):`);
      for (const candidate of candidates) {
        console.log(`  ${candidate.objectKey} (${candidate.sizeBytes} bytes, last modified ${candidate.lastModified.toISOString()})`);
      }
    } else {
      const result = await reapAbandonedUploads(s3, bucket, db, organisationId);
      console.log(`[${organisationId}] deleted ${result.deleted.length} object(s), freed ${result.bytesFreed} bytes.`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
