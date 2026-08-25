import { and, asc, eq, inArray } from "drizzle-orm";
import { PublishedMetrics, type ListingDetail, type ListingSummary, type StatScope, type StatSnapshot } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { algoListings, algoReleases, listingPrices, publishedStatSnapshots, storefronts, users } from "@arf-os/db";

/**
 * Public catalogue reads (ADR 0015). Every query in this file is scoped to one
 * storefront resolved by slug and to PUBLISHED rows only — there is deliberately
 * no "list all listings" query for an anonymous caller to reach.
 */

export interface StorefrontRow {
  id: string;
  organisationId: string;
  slug: string;
  name: string;
  tagline: string;
  supportEmail: string;
  defaultCurrency: string;
}

export async function getStorefrontBySlug(db: Database, slug: string): Promise<StorefrontRow | null> {
  const [row] = await db
    .select({
      id: storefronts.id,
      organisationId: storefronts.organisationId,
      slug: storefronts.slug,
      name: storefronts.name,
      tagline: storefronts.tagline,
      supportEmail: storefronts.supportEmail,
      defaultCurrency: storefronts.defaultCurrency,
    })
    .from(storefronts)
    .where(eq(storefronts.slug, slug))
    .limit(1);
  return row ?? null;
}

/**
 * Ranked worst-to-best claim: a forward paper result outranks out-of-sample,
 * which outranks in-sample. The catalogue headline shows the strongest
 * *evidence*, never the prettiest number.
 */
const HEADLINE_PRIORITY: readonly StatScope[] = ["FORWARD_PAPER", "OUT_OF_SAMPLE", "IN_SAMPLE"];

interface SnapshotRow {
  id: string;
  releaseId: string;
  scope: StatScope;
  sourceKind: "BACKTEST_RUN" | "FORWARD_DEPLOYMENT" | "CUSTOMER_REPORT_AGGREGATE";
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
 * from the response rather than rendered as a half-populated claim
 * (CLAUDE.md 3.3 — structured data is canonical, and unvalidated JSON is not).
 */
function toMetrics(value: unknown): PublishedMetrics | null {
  const parsed = PublishedMetrics.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toSnapshot(row: SnapshotRow): StatSnapshot | null {
  const metrics = toMetrics(row.metrics);
  if (!metrics) return null;
  return {
    snapshotId: row.id,
    scope: row.scope,
    sourceKind: row.sourceKind,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    metrics,
    monthlyReturns: Array.isArray(row.monthlyReturns) ? (row.monthlyReturns as StatSnapshot["monthlyReturns"]) : [],
    equityCurve: Array.isArray(row.equityCurve) ? (row.equityCurve as StatSnapshot["equityCurve"]) : [],
    calculationVersion: row.calculationVersion,
    costsApplied: row.costsApplied,
  };
}

export interface ListingFilters {
  marketCategory?: string | undefined;
  symbol?: string | undefined;
  timeframe?: string | undefined;
}

export async function listPublishedListings(
  db: Database,
  storefrontId: string,
  filters: ListingFilters = {},
): Promise<ListingSummary[]> {
  const listingRows = await db
    .select({
      id: algoListings.id,
      slug: algoListings.slug,
      name: algoListings.name,
      tagline: algoListings.tagline,
      marketCategory: algoListings.marketCategory,
      symbol: algoListings.symbol,
      timeframe: algoListings.timeframe,
      status: algoListings.status,
      publishedAt: algoListings.publishedAt,
      createdAt: algoListings.createdAt,
    })
    .from(algoListings)
    .where(and(eq(algoListings.storefrontId, storefrontId), eq(algoListings.status, "PUBLISHED")))
    .orderBy(asc(algoListings.createdAt), asc(algoListings.id));

  const filtered = listingRows.filter((row) => {
    if (filters.marketCategory && row.marketCategory !== filters.marketCategory) return false;
    if (filters.symbol && row.symbol !== filters.symbol) return false;
    if (filters.timeframe && row.timeframe !== filters.timeframe) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const listingIds = filtered.map((row) => row.id);
  const priceRows = await db
    .select({
      listingId: listingPrices.listingId,
      currency: listingPrices.currency,
      monthlyAmountMinor: listingPrices.monthlyAmountMinor,
    })
    .from(listingPrices)
    .where(and(inArray(listingPrices.listingId, listingIds), eq(listingPrices.active, true)));
  const priceByListing = new Map(priceRows.map((row) => [row.listingId, row]));

  const releaseRows = await db
    .select({ id: algoReleases.id, listingId: algoReleases.listingId, releaseNumber: algoReleases.releaseNumber })
    .from(algoReleases)
    .where(and(inArray(algoReleases.listingId, listingIds), eq(algoReleases.status, "PUBLISHED")));

  // Highest published release per listing.
  const currentReleaseByListing = new Map<string, { id: string; releaseNumber: number }>();
  for (const row of releaseRows) {
    const current = currentReleaseByListing.get(row.listingId);
    if (!current || row.releaseNumber > current.releaseNumber) {
      currentReleaseByListing.set(row.listingId, { id: row.id, releaseNumber: row.releaseNumber });
    }
  }

  const releaseIds = [...currentReleaseByListing.values()].map((release) => release.id);
  const snapshotRows = releaseIds.length
    ? ((await db
        .select()
        .from(publishedStatSnapshots)
        .where(inArray(publishedStatSnapshots.releaseId, releaseIds))) as SnapshotRow[])
    : [];

  const snapshotsByRelease = new Map<string, SnapshotRow[]>();
  for (const row of snapshotRows) {
    const bucket = snapshotsByRelease.get(row.releaseId) ?? [];
    bucket.push(row);
    snapshotsByRelease.set(row.releaseId, bucket);
  }

  return filtered.map((row) => {
    const price = priceByListing.get(row.id);
    const release = currentReleaseByListing.get(row.id);
    const headlineRow = release ? pickHeadline(snapshotsByRelease.get(release.id) ?? []) : null;
    const headlineMetrics = headlineRow ? toMetrics(headlineRow.metrics) : null;

    return {
      contractVersion: 1 as const,
      listingId: row.id,
      slug: row.slug,
      name: row.name,
      tagline: row.tagline,
      marketCategory: row.marketCategory,
      symbol: row.symbol,
      timeframe: row.timeframe,
      status: row.status,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      monthlyPrice: price ? { currency: price.currency, amountMinor: price.monthlyAmountMinor } : null,
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
    } satisfies ListingSummary;
  });
}

export async function getPublishedListingDetail(
  db: Database,
  storefrontId: string,
  listingSlug: string,
): Promise<ListingDetail | null> {
  const [listing] = await db
    .select()
    .from(algoListings)
    .where(
      and(
        eq(algoListings.storefrontId, storefrontId),
        eq(algoListings.slug, listingSlug),
        eq(algoListings.status, "PUBLISHED"),
      ),
    )
    .limit(1);

  if (!listing) return null;

  const [price] = await db
    .select({ currency: listingPrices.currency, monthlyAmountMinor: listingPrices.monthlyAmountMinor })
    .from(listingPrices)
    .where(and(eq(listingPrices.listingId, listing.id), eq(listingPrices.active, true)))
    .limit(1);

  const releases = await db
    .select()
    .from(algoReleases)
    .where(and(eq(algoReleases.listingId, listing.id), eq(algoReleases.status, "PUBLISHED")));

  const currentRelease = releases.reduce<(typeof releases)[number] | null>(
    (best, candidate) => (!best || candidate.releaseNumber > best.releaseNumber ? candidate : best),
    null,
  );

  const snapshotRows = currentRelease
    ? ((await db
        .select()
        .from(publishedStatSnapshots)
        .where(eq(publishedStatSnapshots.releaseId, currentRelease.id))
        .orderBy(asc(publishedStatSnapshots.scope))) as SnapshotRow[])
    : [];

  const headlineRow = pickHeadline(snapshotRows);
  const headlineMetrics = headlineRow ? toMetrics(headlineRow.metrics) : null;

  const developer = listing.developerUserId
    ? (
        await db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, listing.developerUserId))
          .limit(1)
      )[0]
    : undefined;

  return {
    contractVersion: 1,
    listingId: listing.id,
    slug: listing.slug,
    name: listing.name,
    tagline: listing.tagline,
    marketCategory: listing.marketCategory,
    symbol: listing.symbol,
    timeframe: listing.timeframe,
    status: listing.status,
    publishedAt: listing.publishedAt?.toISOString() ?? null,
    monthlyPrice: price ? { currency: price.currency, amountMinor: price.monthlyAmountMinor } : null,
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
    description: listing.description,
    riskNote: listing.riskNote,
    developer: listing.developerUserId
      ? { displayName: developer?.displayName ?? "Independent developer", isFirstParty: false }
      : { displayName: "In-house research", isFirstParty: true },
    currentRelease: currentRelease
      ? {
          releaseId: currentRelease.id,
          releaseNumber: currentRelease.releaseNumber,
          publishedAt: currentRelease.publishedAt?.toISOString() ?? null,
          changelog: currentRelease.changelog,
          // The source hash is public on purpose: it is what lets a customer
          // check that the code they received is the code that was tested.
          pineSourceHash: currentRelease.pineSourceHash,
        }
      : null,
    snapshots: snapshotRows.map(toSnapshot).filter((snapshot): snapshot is StatSnapshot => snapshot !== null),
  };
}
