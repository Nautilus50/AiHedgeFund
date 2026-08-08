import { describe, expect, it } from "vitest";
import { buildArtefactKey } from "./object-store.js";

describe("buildArtefactKey", () => {
  it("builds the canonical path from spec 14.7", () => {
    const key = buildArtefactKey({
      organisationId: "org-1",
      campaignId: "camp-1",
      strategyId: "strat-1",
      strategyVersionId: "v-1",
      category: "tradingview-verification",
      categoryId: "verif-1",
      filename: "list-of-trades.csv",
    });

    expect(key).toBe(
      "orgs/org-1/campaigns/camp-1/strategies/strat-1/versions/v-1/tradingview-verification/verif-1/list-of-trades.csv",
    );
  });

  it("keeps distinct verifications for the same strategy version from colliding", () => {
    const base = {
      organisationId: "org-1",
      campaignId: "camp-1",
      strategyId: "strat-1",
      strategyVersionId: "v-1",
      category: "tradingview-verification" as const,
      filename: "list-of-trades.csv",
    };

    const keyA = buildArtefactKey({ ...base, categoryId: "verif-1" });
    const keyB = buildArtefactKey({ ...base, categoryId: "verif-2" });

    expect(keyA).not.toBe(keyB);
  });
});
