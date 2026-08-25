import { and, asc, eq, inArray } from "drizzle-orm";
import { AlgoMetrics, type AlgoDetail, type AlgoStatus, type AlgoSummary, type StatScope, type StatSnapshot } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { algoReleases, algoStatSnapshots, algos } from "@arf-os/db";

/**
 * Library reads (ADR 0015). Every query is scoped to the caller's organisation —
 * the library is private, and there is deliberately no "list every algo" query.
 */

/**
 * Ranked worst-to-best claim: a forward paper result outranks out-of-sample,
 * which outranks in-sample. The headline shows the strongest *evidence*, never
 * the prettiest number.
 */
const HEADLINE_PRIORITY: readonly StatScope[] = ["FORWARD_PAPER", "OUT_OF_SAMPLE", "IN_SAMPLE"];

interface SnapshotRow {
  id: string;
  releaseId: string;
  scope: StatScope;
  sourceKind: "BACKTEST_RUN" | "FORWARD_DEPLOYMENT";
  sourceId: string;
  periodStart: Date;
  periodEnd: Date;
  metrics: unknown;
  monthlyReturns: unknown;
  equityCurve: unknown;
  calculationVersion: string;
  costsApplied: boolean;
}

function pickHeadline(snapshots: readonly SnapshotRow[]): SnapshotRow | null {
  for (const scope of HEADLINE_PRIORITY) {
    const match = snapshots.find((snapshot) => snapshot.scope === scope);
    if (match) return match;
  }
  return null;
}

/**
 * Stored metrics are re-validated on the way out. A snapshot written by an
 * older calculation version that no longer satisfies the contract is dropped
 * rather than rendered as a half-populated claim (CLAUDE.md 3.3 — structured
 * data is canonical, and unvalidated JSON is not).
 */
function toMetrics(value: unknown): AlgoMetrics | null {
  const parsed = AlgoMetrics.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toSnapshot(row: SnapshotRow): StatSnapshot | null {
  const metrics = toMetrics(row.metrics);
  if (!metrics) return null;
  return {
    snapshotId: row.id,
    scope: row.scope,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    metrics,
    monthlyReturns: Array.isArray(row.monthlyReturns) ? (row.monthlyReturns as StatSnapshot["monthlyReturns"]) : [],
    equityCurve: Array.isArray(row.equityCurve) ? (row.equityCurve as StatSnapshot["equityCurve"]) : [],
    calculationVersion: row.calculationVersion,
    costsApplied: row.costsApplied,
  };
}

export interface AlgoFilters {
  status?: AlgoStatus | undefined;
  marketCategory?: string | undefined;
  symbol?: string | undefined;
  timeframe?: string | undefined;
}

export async function listAlgos(
  db: Database,
  organisationId: string,
  filters: AlgoFilters = {},
): Promise<AlgoSummary[]> {
  const rows = await db
    .select()
    .from(algos)
    .where(
      filters.status
        ? and(eq(algos.organisationId, organisationId), eq(algos.status, filters.status))
        : eq(algos.organisationId, organisationId),
    )
    .orderBy(asc(algos.createdAt), asc(algos.id));

  const filtered = rows.filter((row) => {
    if (filters.marketCategory && row.marketCategory !== filters.marketCategory) return false;
    if (filters.symbol && row.symbol !== filters.symbol) return false;
    if (filters.timeframe && row.timeframe !== filters.timeframe) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const algoIds = filtered.map((row) => row.id);
  const releaseRows = await db
    .select({ id: algoReleases.id, algoId: algoReleases.algoId, releaseNumber: algoReleases.releaseNumber })
    .from(algoReleases)
    .where(and(inArray(algoReleases.algoId, algoIds), eq(algoReleases.status, "PUBLISHED")));

  // Highest published release per algo.
  const currentReleaseByAlgo = new Map<string, { id: string; releaseNumber: number }>();
  for (const row of releaseRows) {
    const current = currentReleaseByAlgo.get(row.algoId);
    if (!current || row.releaseNumber > current.releaseNumber) {
      currentReleaseByAlgo.set(row.algoId, { id: row.id, releaseNumber: row.releaseNumber });
    }
  }

  const releaseIds = [...currentReleaseByAlgo.values()].map((release) => release.id);
  const snapshotRows = releaseIds.length
    ? ((await db.select().from(algoStatSnapshots).where(inArray(algoStatSnapshots.releaseId, releaseIds))) as SnapshotRow[])
    : [];

  const snapshotsByRelease = new Map<string, SnapshotRow[]>();
  for (const row of snapshotRows) {
    const bucket = snapshotsByRelease.get(row.releaseId) ?? [];
    bucket.push(row);
    snapshotsByRelease.set(row.releaseId, bucket);
  }

  return filtered.map((row) => {
    const release = currentReleaseByAlgo.get(row.id);
    const headlineRow = release ? pickHeadline(snapshotsByRelease.get(release.id) ?? []) : null;
    const headlineMetrics = headlineRow ? toMetrics(headlineRow.metrics) : null;

    return {
      contractVersion: 1 as const,
      algoId: row.id,
      slug: row.slug,
      name: row.name,
      tagline: row.tagline,
      marketCategory: row.marketCategory,
      symbol: row.symbol,
      timeframe: row.timeframe,
      status: row.status,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      headline:
        headlineRow && headlineMetrics
          ? {
              scope: headlineRow.scope,
              periodStart: headlineRow.periodStart.toISOString(),
              periodEnd: headlineRow.periodEnd.toISOString(),
              netProfitPct: headlineMetrics.netProfitPct,
              maxDrawdownPct: headlineMetrics.maxDrawdownPct,
              profitFactor: headlineMetrics.profitFactor,
              tradeCount: headlineMetrics.tradeCount,
            }
          : null,
    } satisfies AlgoSummary;
  });
}

export async function getAlgoDetail(
  db: Database,
  organisationId: string,
  slug: string,
): Promise<AlgoDetail | null> {
  const [algo] = await db
    .select()
    .from(algos)
    // Ownership is part of the lookup, not a check afterwards: another
    // organisation's algo simply does not resolve.
    .where(and(eq(algos.organisationId, organisationId), eq(algos.slug, slug)))
    .limit(1);

  if (!algo) return null;

  const releases = await db
    .select()
    .from(algoReleases)
    .where(and(eq(algoReleases.algoId, algo.id), eq(algoReleases.status, "PUBLISHED")));

  const currentRelease = releases.reduce<(typeof releases)[number] | null>(
    (best, candidate) => (!best || candidate.releaseNumber > best.releaseNumber ? candidate : best),
    null,
  );

  const snapshotRows = currentRelease
    ? ((await db
        .select()
        .from(algoStatSnapshots)
        .where(eq(algoStatSnapshots.releaseId, currentRelease.id))
        .orderBy(asc(algoStatSnapshots.scope))) as SnapshotRow[])
    : [];

  const headlineRow = pickHeadline(snapshotRows);
  const headlineMetrics = headlineRow ? toMetrics(headlineRow.metrics) : null;

  return {
    contractVersion: 1,
    algoId: algo.id,
    slug: algo.slug,
    name: algo.name,
    tagline: algo.tagline,
    marketCategory: algo.marketCategory,
    symbol: algo.symbol,
    timeframe: algo.timeframe,
    status: algo.status,
    publishedAt: algo.publishedAt?.toISOString() ?? null,
    headline:
      headlineRow && headlineMetrics
        ? {
            scope: headlineRow.scope,
            periodStart: headlineRow.periodStart.toISOString(),
            periodEnd: headlineRow.periodEnd.toISOString(),
            netProfitPct: headlineMetrics.netProfitPct,
            maxDrawdownPct: headlineMetrics.maxDrawdownPct,
            profitFactor: headlineMetrics.profitFactor,
            tradeCount: headlineMetrics.tradeCount,
          }
        : null,
    description: algo.description,
    riskNote: algo.riskNote,
    currentRelease: currentRelease
      ? {
          releaseId: currentRelease.id,
          releaseNumber: currentRelease.releaseNumber,
          strategyVersionId: currentRelease.strategyVersionId,
          publishedAt: currentRelease.publishedAt?.toISOString() ?? null,
          changelog: currentRelease.changelog,
          // The hash is what lets you check that the code you are about to run
          // is the code the evidence above was produced from.
          pineSourceHash: currentRelease.pineSourceHash,
        }
      : null,
    snapshots: snapshotRows.map(toSnapshot).filter((snapshot): snapshot is StatSnapshot => snapshot !== null),
  };
}
