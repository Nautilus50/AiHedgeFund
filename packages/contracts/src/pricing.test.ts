import { describe, expect, it } from "vitest";
import { quoteSubscription, selectVolumeTier, type PriceableListing } from "./pricing.js";
import type { VolumeDiscountTier } from "./storefront.js";

const TIERS: VolumeDiscountTier[] = [
  { minAlgos: 2, discountBps: 1000 },
  { minAlgos: 4, discountBps: 2000 },
  { minAlgos: 8, discountBps: 3000 },
];

function listing(n: number, amountMinor = 4900, currency = "USD"): PriceableListing {
  return {
    listingId: `00000000-0000-4000-8000-00000000000${n}`,
    slug: `algo-${n}`,
    name: `Algo ${n}`,
    currency,
    monthlyAmountMinor: amountMinor,
  };
}

describe("selectVolumeTier", () => {
  it("returns null below the first tier", () => {
    expect(selectVolumeTier(TIERS, 1)).toBeNull();
  });

  it("selects the highest tier the count reaches", () => {
    expect(selectVolumeTier(TIERS, 3)?.discountBps).toBe(1000);
    expect(selectVolumeTier(TIERS, 4)?.discountBps).toBe(2000);
    expect(selectVolumeTier(TIERS, 40)?.discountBps).toBe(3000);
  });

  it("prefers the larger discount when two tiers share a minAlgos", () => {
    const duplicated: VolumeDiscountTier[] = [
      { minAlgos: 2, discountBps: 500 },
      { minAlgos: 2, discountBps: 1500 },
    ];
    expect(selectVolumeTier(duplicated, 2)?.discountBps).toBe(1500);
  });
});

describe("quoteSubscription", () => {
  it("charges list price for a single algo", () => {
    const result = quoteSubscription([listing(1)], TIERS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.appliedTier).toBeNull();
    expect(result.quote.discountTotalMinor).toBe(0);
    expect(result.quote.totalMinor).toBe(4900);
  });

  it("applies the volume tier to every line", () => {
    const result = quoteSubscription([listing(1), listing(2), listing(3), listing(4)], TIERS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.appliedTier?.discountBps).toBe(2000);
    expect(result.quote.lines.every((line) => line.discountAmountMinor === 980)).toBe(true);
    expect(result.quote.totalMinor).toBe(4 * (4900 - 980));
  });

  it("keeps the lines summing to the charged total under rounding", () => {
    // 3333 * 10% = 333.3 -> 333 per line; a total-level rounding would drift.
    const result = quoteSubscription([listing(1, 3333), listing(2, 3333), listing(3, 3333)], TIERS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summed = result.quote.lines.reduce((sum, line) => sum + line.netAmountMinor, 0);
    expect(summed).toBe(result.quote.totalMinor);
    expect(result.quote.totalMinor).toBe(3 * 3000);
  });

  it("never produces a fractional minor unit", () => {
    const result = quoteSubscription([listing(1, 999), listing(2, 999)], [{ minAlgos: 2, discountBps: 333 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const line of result.quote.lines) {
      expect(Number.isInteger(line.netAmountMinor)).toBe(true);
      expect(Number.isInteger(line.discountAmountMinor)).toBe(true);
    }
    expect(Number.isInteger(result.quote.totalMinor)).toBe(true);
  });

  it("rejects an empty selection", () => {
    const result = quoteSubscription([], TIERS);
    expect(result).toMatchObject({ ok: false, reasonCode: "EMPTY_SELECTION" });
  });

  it("rejects a duplicated listing rather than double-charging", () => {
    const result = quoteSubscription([listing(1), listing(1)], TIERS);
    expect(result).toMatchObject({ ok: false, reasonCode: "DUPLICATE_LISTING" });
  });

  it("rejects a mixed-currency selection", () => {
    const result = quoteSubscription([listing(1, 4900, "USD"), listing(2, 4900, "EUR")], TIERS);
    expect(result).toMatchObject({ ok: false, reasonCode: "MIXED_CURRENCY" });
  });

  it("counts the selection, not the spend, when choosing a tier", () => {
    const result = quoteSubscription([listing(1, 100_000), listing(2, 100)], TIERS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.appliedTier?.minAlgos).toBe(2);
  });
});
