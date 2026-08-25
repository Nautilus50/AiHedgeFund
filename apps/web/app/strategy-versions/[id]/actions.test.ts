import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const redirect = vi.fn(() => {
  // Next's redirect() throws to unwind the request; mirroring that here keeps
  // the action's control flow under test identical to production.
  throw new Error("NEXT_REDIRECT");
});

vi.mock("../../../lib/api", () => ({ apiFetch }));
vi.mock("next/navigation", () => ({ redirect }));

const { catalogueAlgoAction } = await import("./actions");

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    existingSlug: "",
    name: "Momentum BTC",
    slug: "momentum-btc",
    tagline: "Trend continuation.",
    marketCategory: "CRYPTO",
    symbol: "BTCUSD",
    timeframe: "60",
    changelog: "First release.",
    setupInstructions: "Paste into TradingView.",
    backtestRunId: "",
    scope: "OUT_OF_SAMPLE",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== "") data.set(key, value);
  }
  return data;
}

/** Runs the action, absorbing the redirect throw so the calls can be asserted. */
async function run(data: FormData) {
  try {
    return await catalogueAlgoAction(VERSION_ID, {}, data);
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirected: true } as const;
    throw error;
  }
}

describe("catalogueAlgoAction", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    redirect.mockClear();
  });

  it("creates the algo, pins a release, records evidence, then publishes", async () => {
    apiFetch
      .mockResolvedValueOnce({ algoId: "algo-1" })
      .mockResolvedValueOnce({ releaseId: "release-1" })
      .mockResolvedValueOnce({ snapshotId: "snapshot-1" })
      .mockResolvedValueOnce({ status: "PUBLISHED" });

    await run(form({ backtestRunId: RUN_ID, publishNow: "on" }));

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      "/v1/algos",
      "/v1/algos/algo-1/releases",
      "/v1/algo-releases/release-1/stats",
      "/v1/algos/algo-1/publish",
    ]);

    // The release is pinned to this version, not to whatever the form said.
    expect(JSON.parse(String(apiFetch.mock.calls[1]?.[1]?.body))).toMatchObject({ strategyVersionId: VERSION_ID });
    expect(redirect).toHaveBeenCalledWith("/algos/momentum-btc");
  });

  it("resolves an existing algo by slug instead of creating one", async () => {
    apiFetch.mockResolvedValueOnce({ algoId: "algo-9" }).mockResolvedValueOnce({ releaseId: "release-9" });

    await run(form({ existingSlug: "momentum-btc" }));

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      "/v1/algos/momentum-btc",
      "/v1/algos/algo-9/releases",
    ]);
    expect(redirect).toHaveBeenCalledWith("/algos/momentum-btc");
  });

  it("skips the evidence and publish calls when no run is chosen", async () => {
    apiFetch.mockResolvedValueOnce({ algoId: "algo-1" }).mockResolvedValueOnce({ releaseId: "release-1" });

    await run(form());

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("says the algo was created when the release fails afterwards", async () => {
    apiFetch
      .mockResolvedValueOnce({ algoId: "algo-1" })
      .mockRejectedValueOnce(new Error("A release requires a PAPER_APPROVED strategy version."));

    const result = await run(form());

    // A half-catalogued algo the operator does not know about is worse than
    // one they do — the error has to name what already exists.
    expect(result).toMatchObject({
      error: expect.stringContaining('Algo "momentum-btc" was created as a draft.') as unknown as string,
    });
    expect(String((result as { error: string }).error)).toContain("PAPER_APPROVED");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("reports a released-but-unevidenced algo distinctly", async () => {
    apiFetch
      .mockResolvedValueOnce({ algoId: "algo-1" })
      .mockResolvedValueOnce({ releaseId: "release-1" })
      .mockRejectedValueOnce(new Error("That run belongs to a different strategy version than this release."));

    const result = await run(form({ backtestRunId: RUN_ID }));

    expect(String((result as { error: string }).error)).toContain("The release was published, but the evidence was not");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("reports a still-draft algo when publishing fails", async () => {
    apiFetch
      .mockResolvedValueOnce({ algoId: "algo-1" })
      .mockResolvedValueOnce({ releaseId: "release-1" })
      .mockResolvedValueOnce({ snapshotId: "snapshot-1" })
      .mockRejectedValueOnce(new Error("Catalogue at least one evidence snapshot before publishing the algo."));

    const result = await run(form({ backtestRunId: RUN_ID, publishNow: "on" }));

    expect(String((result as { error: string }).error)).toContain("the algo is still a draft");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("rejects a malformed slug before calling the API at all", async () => {
    const result = await run(form({ slug: "Momentum BTC" }));

    expect(result).toMatchObject({ error: expect.stringContaining("lower-case words") as unknown as string });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("requires the identifying fields for a new algo", async () => {
    const data = form();
    data.delete("symbol");

    const result = await run(data);

    expect(result).toMatchObject({ error: expect.stringContaining("required") as unknown as string });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
