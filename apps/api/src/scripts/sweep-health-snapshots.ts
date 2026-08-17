import { createDatabase, organisations } from "@arf-os/db";
import { sweepHealthSnapshots } from "../services/forward-deployments.js";

/**
 * Operator-run maintenance script for ADR 0012's persisted health-snapshot
 * history — mirrors `reap-abandoned-uploads.ts`'s exact pattern: this repo
 * has no in-process scheduled-job mechanism (see ADR 0006/0007's precedent
 * against inventing one ahead of need), so this is meant to be wired to
 * whatever the deployment platform's own scheduler is (a Railway cron
 * service, a GitHub Actions schedule, etc.), not run by anything inside
 * this codebase automatically.
 *
 * Usage:
 *   tsx src/scripts/sweep-health-snapshots.ts [organisationId] [--dry-run]
 *
 * With no organisationId, sweeps every organisation. --dry-run reports which
 * deployments would get a snapshot without writing anything. One `tickAt` is
 * computed here, shared across every organisation in this run, so re-running
 * the script after a partial failure is a safe no-op for whatever already
 * succeeded (see `sweepHealthSnapshots`'s idempotency check).
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
  const tickAt = new Date();

  const targetOrgIds = organisationIdArg
    ? [organisationIdArg]
    : (await db.select({ id: organisations.id }).from(organisations)).map((row) => row.id);

  for (const organisationId of targetOrgIds) {
    const results = await sweepHealthSnapshots(db, organisationId, tickAt, dryRun);
    const written = results.filter((r) => !r.skippedExisting).length;
    const skipped = results.length - written;
    console.log(
      `[${organisationId}] ${dryRun ? "would write" : "wrote"} ${written} snapshot(s)${skipped > 0 ? `, skipped ${skipped} already-recorded for this tick` : ""}.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
