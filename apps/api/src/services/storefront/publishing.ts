import { and, asc, desc, eq, max } from "drizzle-orm";
import { generateId, PublishedMetrics } from "@arf-os/contracts";
import type { MarketCategory, StatScope } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  algoListings,
  algoReleases,
  auditEvents,
  backtestRuns,
  listingPrices,
  pineRevisions,
  publishedStatSnapshots,
  storefronts,
  strategyVersions,
  trades,
} from "@arf-os/db";
import {
  calculateCoreMetrics,
  computeDrawdownCurve,
  reconstructEquityCurve,
  METRICS_CALCULATION_VERSION,
} from "@arf-os/metrics";
import type { MetricsTrade } from "@arf-os/metrics";

/**
 * Admin publishing (ADR 0015). The rule this file exists to enforce: an algo
 * reaches the catalogue only by way of an immutable strategy version that has
 * already survived the research gates, and every published number is recomputed
 * here from the stored ledger rather than copied from a report.
 */

export type PublishFailure = { ok: false; reasonCode: string; message: string };

export interface CreateListingInput {
  storefrontId: string;
  organisationId: string;
  actorUserId: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  riskNote: string;
  marketCategory: MarketCategory;
  symbol: string;
  timeframe: string;
  developerUserId?: string | null;
  revenueShareBps?: number;
}

export async function createListing(
  db: Database,
  input: CreateListingInput,
): Promise<{ ok: true; listingId: string } | PublishFailure> {
  const [existing] = await db
    .select({ id: algoListings.id })
    .from(algoListings)
    .where(and(eq(algoListings.storefrontId, input.storefrontId), eq(algoListings.slug, input.slug)))
    .limit(1);

  if (existing) {
    return { ok: false, reasonCode: "SLUG_TAKEN", message: `Slug "${input.slug}" already exists in this storefront.` };
  }

  const listingId = generateId();
  await db.insert(algoListings).values({
    id: listingId,
    storefrontId: input.storefrontId,
    slug: input.slug,
    name: input.name,
    tagline: input.tagline,
    description: input.description,
    riskNote: input.riskNote,
    marketCategory: input.marketCategory,
    symbol: input.symbol,
    timeframe: input.timeframe,
    status: "DRAFT",
    developerUserId: input.developerUserId ?? null,
    revenueShareBps: input.revenueShareBps ?? 0,
  });

  return { ok: true, listingId };
}

export interface SetPriceInput {
  listingId: string;
  currency: string;
  monthlyAmountMinor: number;
}

/**
 * Prices are superseded, not edited: the previous row is deactivated and a new
 * one inserted, so what a past subscriber was quoted stays legible.
 */
export async function setListingPrice(db: Database, input: SetPriceInput): Promise<{ ok: true; priceId: string }> {
  const priceId = generateId();
  await db.transaction(async (tx) => {
    await tx.update(listingPrices).set({ active: false }).where(eq(listingPrices.listingId, input.listingId));
    await tx.insert(listingPrices).values({
      id: priceId,
      listingId: input.listingId,
      currency: input.currency,
      monthlyAmountMinor: input.monthlyAmountMinor,
      active: true,
    });
  });
  return { ok: true, priceId };
}

export interface PublishReleaseInput {
  listingId: string;
  strategyVersionId: string;
  changelog: string;
  setupInstructions: string;
  actorUserId: string;
  traceId?: string;
}

/**
 * The promotion gate. A strategy version may back a public release only once it
 * reached PAPER_APPROVED — the state that requires a committee decision the
 * strategy's own author could not make (CLAUDE.md 3.4).
 */
export async function publishRelease(
  db: Database,
  input: PublishReleaseInput,
): Promise<{ ok: true; releaseId: string; releaseNumber: number } | PublishFailure> {
  const [listing] = await db
    .select({ id: algoListings.id, storefrontId: algoListings.storefrontId })
    .from(algoListings)
    .where(eq(algoListings.id, input.listingId))
    .limit(1);

  if (!listing) {
    return { ok: false, reasonCode: "LISTING_NOT_FOUND", message: "No such listing." };
  }

  const [version] = await db
    .select({ id: strategyVersions.id, workflowState: strategyVersions.workflowState })
    .from(strategyVersions)
    .where(eq(strategyVersions.id, input.strategyVersionId))
    .limit(1);

  if (!version) {
    return { ok: false, reasonCode: "STRATEGY_VERSION_NOT_FOUND", message: "No such strategy version." };
  }

  if (version.workflowState !== "PAPER_APPROVED") {
    return {
      ok: false,
      reasonCode: "NOT_PAPER_APPROVED",
      message: `A release requires a PAPER_APPROVED strategy version (this one is ${version.workflowState}).`,
    };
  }

  const [revision] = await db
    .select({ sourceHash: pineRevisions.sourceHash })
    .from(pineRevisions)
    .where(eq(pineRevisions.strategyVersionId, input.strategyVersionId))
    .limit(1);

  if (!revision) {
    return { ok: false, reasonCode: "NO_PINE_REVISION", message: "That strategy version has no Pine revision." };
  }

  const [existingForVersion] = await db
    .select({ id: algoReleases.id, releaseNumber: algoReleases.releaseNumber })
    .from(algoReleases)
    .where(
      and(eq(algoReleases.listingId, input.listingId), eq(algoReleases.strategyVersionId, input.strategyVersionId)),
    )
    .limit(1);

  if (existingForVersion) {
    // Idempotent: republishing the same version returns the release that
    // already represents it rather than minting a duplicate.
    return { ok: true, releaseId: existingForVersion.id, releaseNumber: existingForVersion.releaseNumber };
  }

  const [{ highest } = { highest: null }] = await db
    .select({ highest: max(algoReleases.releaseNumber) })
    .from(algoReleases)
    .where(eq(algoReleases.listingId, input.listingId));

  const releaseNumber = (highest ?? 0) + 1;
  const releaseId = generateId();

  const [storefront] = await db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, listing.storefrontId))
    .limit(1);

  await db.transaction(async (tx) => {
    // Everything previously published becomes SUPERSEDED in the same
    // transaction, so there is never a moment with two "current" releases.
    await tx
      .update(algoReleases)
      .set({ status: "SUPERSEDED" })
      .where(and(eq(algoReleases.listingId, input.listingId), eq(algoReleases.status, "PUBLISHED")));

    await tx.insert(algoReleases).values({
      id: releaseId,
      listingId: input.listingId,
      strategyVersionId: input.strategyVersionId,
      releaseNumber,
      status: "PUBLISHED",
      changelog: input.changelog,
      setupInstructions: input.setupInstructions,
      pineSourceHash: revision.sourceHash,
      publishedAt: new Date(),
    });

    if (storefront) {
      await tx.insert(auditEvents).values({
        id: generateId(),
        organisationId: storefront.organisationId,
        actor: `user:${input.actorUserId}`,
        action: "ALGO_RELEASE_PUBLISHED",
        aggregateType: "algo_listing",
        aggregateId: input.listingId,
        priorStateSummary: { latestReleaseNumber: highest ?? 0 },
        newStateSummary: {
          releaseNumber,
          strategyVersionId: input.strategyVersionId,
          pineSourceHash: revision.sourceHash,
        },
        reason: input.changelog || "Release published.",
        traceId: input.traceId ?? null,
      });
    }
  });

  return { ok: true, releaseId, releaseNumber };
}

export interface PublishStatsInput {
  releaseId: string;
  backtestRunId: string;
  scope: StatScope;
  actorUserId: string;
  traceId?: string;
}

/**
 * Builds a published snapshot by recomputing metrics from the stored trade
 * ledger and equity series (CLAUDE.md 14 — independent calculation). Nothing
 * here reads a runner-reported summary, so a catalogue number cannot be better
 * than the trades that produced it.
 */
export async function publishStatSnapshot(
  db: Database,
  input: PublishStatsInput,
): Promise<{ ok: true; snapshotId: string } | PublishFailure> {
  const [release] = await db
    .select({ id: algoReleases.id, listingId: algoReleases.listingId, strategyVersionId: algoReleases.strategyVersionId })
    .from(algoReleases)
    .where(eq(algoReleases.id, input.releaseId))
    .limit(1);

  if (!release) {
    return { ok: false, reasonCode: "RELEASE_NOT_FOUND", message: "No such release." };
  }

  const [run] = await db
    .select()
    .from(backtestRuns)
    .where(eq(backtestRuns.id, input.backtestRunId))
    .limit(1);

  if (!run) {
    return { ok: false, reasonCode: "RUN_NOT_FOUND", message: "No such backtest run." };
  }

  if (run.strategyVersionId !== release.strategyVersionId) {
    return {
      ok: false,
      reasonCode: "RUN_VERSION_MISMATCH",
      message: "That run belongs to a different strategy version than this release.",
    };
  }

  if (run.status !== "SUCCEEDED") {
    return { ok: false, reasonCode: "RUN_NOT_SUCCEEDED", message: `Run status is ${run.status}.` };
  }

  const tradeRows = await db
    .select()
    .from(trades)
    .where(eq(trades.backtestRunId, input.backtestRunId))
    .orderBy(asc(trades.sequenceNumber));

  if (tradeRows.length === 0) {
    return { ok: false, reasonCode: "NO_TRADES", message: "A run with no trades has nothing to publish." };
  }

  const metricsTrades: MetricsTrade[] = tradeRows.map((row) => ({
    tradeNumber: row.sequenceNumber,
    direction: row.direction,
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString(),
    netPnl: row.netPnl === null ? undefined : Number(row.netPnl),
    isOpen: row.exitTime === null,
  }));

  const core = calculateCoreMetrics(metricsTrades);

  // The published curve is reconstructed from the ledger, not read from the
  // stored equity_points a runner produced — same rule as everywhere else in
  // packages/metrics: the trades are the evidence.
  const initialCapital = Number(run.initialCapital);
  const equityCurve = reconstructEquityCurve(metricsTrades, run.initialCapital);
  const drawdown = computeDrawdownCurve(equityCurve);
  const netProfit = Number(core.netProfit);

  const metrics = PublishedMetrics.parse({
    netProfitPct: initialCapital === 0 ? 0 : (netProfit / initialCapital) * 100,
    maxDrawdownPct: Number(drawdown.maxDrawdownPct),
    profitFactor: core.profitFactor,
    winRatePct: core.winRatePct,
    tradeCount: core.closedTradeCount,
    sharpe: null,
    averageTradePct:
      core.closedTradeCount === 0 || initialCapital === 0
        ? null
        : (netProfit / core.closedTradeCount / initialCapital) * 100,
  });

  const monthlyReturns = core.monthlyReturns.map((entry) => ({
    month: entry.month,
    returnPct: initialCapital === 0 ? 0 : (Number(entry.netProfit) / initialCapital) * 100,
  }));

  const snapshotId = generateId();

  await db
    .insert(publishedStatSnapshots)
    .values({
      id: snapshotId,
      releaseId: input.releaseId,
      scope: input.scope,
      sourceKind: "BACKTEST_RUN",
      sourceId: input.backtestRunId,
      periodStart: run.fromTs,
      periodEnd: run.toTs,
      metrics,
      monthlyReturns,
      equityCurve: equityCurve.map((point) => ({ at: point.time, equity: Number(point.equity) })),
      calculationVersion: METRICS_CALCULATION_VERSION,
      // The run's cost model is applied inside the stored net P&L, so every
      // published number here is net — never gross dressed up as net.
      costsApplied: true,
    })
    .onConflictDoUpdate({
      target: [publishedStatSnapshots.releaseId, publishedStatSnapshots.scope, publishedStatSnapshots.sourceId],
      set: { metrics, monthlyReturns, calculationVersion: METRICS_CALCULATION_VERSION },
    });

  return { ok: true, snapshotId };
}

export interface ListingVisibilityInput {
  listingId: string;
  actorUserId: string;
  traceId?: string;
}

/**
 * Makes a listing visible in the catalogue. Refuses without a published release
 * and an active price — a public page that cannot be bought or delivered is a
 * bug, not a teaser.
 */
export async function publishListing(
  db: Database,
  input: ListingVisibilityInput,
): Promise<{ ok: true } | PublishFailure> {
  const [listing] = await db
    .select({ id: algoListings.id, storefrontId: algoListings.storefrontId, status: algoListings.status })
    .from(algoListings)
    .where(eq(algoListings.id, input.listingId))
    .limit(1);

  if (!listing) return { ok: false, reasonCode: "LISTING_NOT_FOUND", message: "No such listing." };

  const [release] = await db
    .select({ id: algoReleases.id })
    .from(algoReleases)
    .where(and(eq(algoReleases.listingId, input.listingId), eq(algoReleases.status, "PUBLISHED")))
    .orderBy(desc(algoReleases.releaseNumber))
    .limit(1);

  if (!release) {
    return { ok: false, reasonCode: "NO_PUBLISHED_RELEASE", message: "Publish a release before the listing." };
  }

  const [price] = await db
    .select({ id: listingPrices.id })
    .from(listingPrices)
    .where(and(eq(listingPrices.listingId, input.listingId), eq(listingPrices.active, true)))
    .limit(1);

  if (!price) {
    return { ok: false, reasonCode: "NO_ACTIVE_PRICE", message: "Set a price before publishing the listing." };
  }

  const [snapshot] = await db
    .select({ id: publishedStatSnapshots.id })
    .from(publishedStatSnapshots)
    .where(eq(publishedStatSnapshots.releaseId, release.id))
    .limit(1);

  if (!snapshot) {
    return {
      ok: false,
      reasonCode: "NO_PUBLISHED_EVIDENCE",
      message: "Publish at least one evidence snapshot before the listing goes public.",
    };
  }

  const [storefront] = await db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, listing.storefrontId))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx
      .update(algoListings)
      .set({ status: "PUBLISHED", publishedAt: new Date() })
      .where(eq(algoListings.id, input.listingId));

    if (storefront) {
      await tx.insert(auditEvents).values({
        id: generateId(),
        organisationId: storefront.organisationId,
        actor: `user:${input.actorUserId}`,
        action: "ALGO_LISTING_PUBLISHED",
        aggregateType: "algo_listing",
        aggregateId: input.listingId,
        priorStateSummary: { status: listing.status },
        newStateSummary: { status: "PUBLISHED" },
        reason: "Listing made publicly visible.",
        traceId: input.traceId ?? null,
      });
    }
  });

  return { ok: true };
}

export async function retireListing(
  db: Database,
  input: ListingVisibilityInput,
): Promise<{ ok: true } | PublishFailure> {
  const [listing] = await db
    .select({ id: algoListings.id, storefrontId: algoListings.storefrontId, status: algoListings.status })
    .from(algoListings)
    .where(eq(algoListings.id, input.listingId))
    .limit(1);

  if (!listing) return { ok: false, reasonCode: "LISTING_NOT_FOUND", message: "No such listing." };

  const [storefront] = await db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, listing.storefrontId))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx.update(algoListings).set({ status: "RETIRED" }).where(eq(algoListings.id, input.listingId));

    if (storefront) {
      await tx.insert(auditEvents).values({
        id: generateId(),
        organisationId: storefront.organisationId,
        actor: `user:${input.actorUserId}`,
        action: "ALGO_LISTING_RETIRED",
        aggregateType: "algo_listing",
        aggregateId: input.listingId,
        priorStateSummary: { status: listing.status },
        newStateSummary: { status: "RETIRED" },
        // Retiring hides the listing from the catalogue; it deliberately does
        // NOT revoke entitlements — existing subscribers keep what they pay for.
        reason: "Listing withdrawn from the catalogue.",
        traceId: input.traceId ?? null,
      });
    }
  });

  return { ok: true };
}
