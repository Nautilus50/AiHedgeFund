import type { SubscriptionQuote, SubscriptionQuoteLine, VolumeDiscountTier } from "./storefront.js";

export interface PriceableListing {
  listingId: string;
  slug: string;
  name: string;
  currency: string;
  monthlyAmountMinor: number;
}

export type QuoteFailure =
  | { ok: false; reasonCode: "EMPTY_SELECTION"; message: string }
  | { ok: false; reasonCode: "MIXED_CURRENCY"; message: string }
  | { ok: false; reasonCode: "DUPLICATE_LISTING"; message: string };

export type QuoteResult = { ok: true; quote: SubscriptionQuote } | QuoteFailure;

/**
 * Picks the most generous tier whose `minAlgos` the selection reaches. Ties on
 * `minAlgos` resolve to the larger discount so a mis-entered duplicate tier can
 * never quietly charge a customer more than the catalogue advertises.
 */
export function selectVolumeTier(tiers: readonly VolumeDiscountTier[], algoCount: number): VolumeDiscountTier | null {
  let best: VolumeDiscountTier | null = null;
  for (const tier of tiers) {
    if (algoCount < tier.minAlgos) continue;
    if (!best || tier.discountBps > best.discountBps) best = tier;
  }
  return best;
}

/**
 * Per-line discount in minor units, rounded half-up. Rounding is applied per
 * line rather than to the total so the sum of the lines always equals the
 * charged total — an invoice whose lines do not add up is a support ticket.
 */
function discountForLine(listAmountMinor: number, discountBps: number): number {
  return Math.round((listAmountMinor * discountBps) / 10_000);
}

/**
 * Deterministic monthly quote for a set of algos, in integer minor units
 * throughout (CLAUDE.md 7.4 — no binary floating point in an authoritative
 * total). Pure: the same selection always produces the same total, which is
 * what makes the quote safe to show before checkout and re-derive after it.
 */
export function quoteSubscription(
  listings: readonly PriceableListing[],
  tiers: readonly VolumeDiscountTier[],
): QuoteResult {
  if (listings.length === 0) {
    return { ok: false, reasonCode: "EMPTY_SELECTION", message: "A subscription needs at least one algo." };
  }

  const seen = new Set<string>();
  for (const listing of listings) {
    if (seen.has(listing.listingId)) {
      return {
        ok: false,
        reasonCode: "DUPLICATE_LISTING",
        message: `Listing ${listing.listingId} appears more than once in the selection.`,
      };
    }
    seen.add(listing.listingId);
  }

  const [first, ...rest] = listings;
  if (!first) {
    return { ok: false, reasonCode: "EMPTY_SELECTION", message: "A subscription needs at least one algo." };
  }
  const currency = first.currency;
  if (rest.some((listing) => listing.currency !== currency)) {
    return {
      ok: false,
      reasonCode: "MIXED_CURRENCY",
      message: "All algos in one subscription must be priced in the same currency.",
    };
  }

  const appliedTier = selectVolumeTier(tiers, listings.length);
  const discountBps = appliedTier?.discountBps ?? 0;

  const lines: SubscriptionQuoteLine[] = listings.map((listing) => {
    const discountAmountMinor = discountForLine(listing.monthlyAmountMinor, discountBps);
    return {
      listingId: listing.listingId,
      slug: listing.slug,
      name: listing.name,
      listAmountMinor: listing.monthlyAmountMinor,
      discountAmountMinor,
      netAmountMinor: listing.monthlyAmountMinor - discountAmountMinor,
    };
  });

  const listTotalMinor = lines.reduce((sum, line) => sum + line.listAmountMinor, 0);
  const discountTotalMinor = lines.reduce((sum, line) => sum + line.discountAmountMinor, 0);

  return {
    ok: true,
    quote: {
      contractVersion: 1,
      currency,
      lines,
      appliedTier,
      listTotalMinor,
      discountTotalMinor,
      totalMinor: listTotalMinor - discountTotalMinor,
      interval: "MONTH",
    },
  };
}
