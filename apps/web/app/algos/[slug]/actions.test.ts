import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const revalidatePath = vi.fn();

/**
 * A stand-in for the real ApiError, defined once here and reused both as the
 * mocked module's export and to construct rejections in the tests below — so
 * `error instanceof ApiError` inside actions.ts sees the exact class the test
 * throws, the same way it would see the real one in production.
 */
class MockApiError extends Error {
  readonly status: number;
  readonly problem: { detail?: string } | undefined;
  constructor(status: number, problem?: { detail?: string }) {
    super(problem?.detail ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../lib/api", () => ({ apiFetch, ApiError: MockApiError }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { publishAlgoAction, refreshForwardEvidenceAction, retireAlgoAction } = await import("./actions");

const ALGO_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const SLUG = "momentum-btc";

beforeEach(() => {
  apiFetch.mockReset();
  revalidatePath.mockClear();
});

describe("publishAlgoAction", () => {
  it("publishes and revalidates the algo's own page", async () => {
    apiFetch.mockResolvedValueOnce(undefined);

    const result = await publishAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({});
    expect(apiFetch).toHaveBeenCalledWith(`/v1/algos/${ALGO_ID}/publish`, { method: "POST" });
    expect(revalidatePath).toHaveBeenCalledWith(`/algos/${SLUG}`);
  });

  it("surfaces the API's own rejection reason", async () => {
    apiFetch.mockRejectedValueOnce(
      new MockApiError(422, { detail: "Catalogue at least one evidence snapshot before publishing the algo." }),
    );

    const result = await publishAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({ error: "Catalogue at least one evidence snapshot before publishing the algo." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for a non-API error", async () => {
    apiFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await publishAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({ error: "Failed to publish this algo." });
  });
});

describe("retireAlgoAction", () => {
  it("retires and revalidates the algo's own page", async () => {
    apiFetch.mockResolvedValueOnce(undefined);

    const result = await retireAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({});
    expect(apiFetch).toHaveBeenCalledWith(`/v1/algos/${ALGO_ID}/retire`, { method: "POST" });
    expect(revalidatePath).toHaveBeenCalledWith(`/algos/${SLUG}`);
  });

  it("surfaces the API's own rejection reason", async () => {
    apiFetch.mockRejectedValueOnce(new MockApiError(404, { detail: "No such algo." }));

    const result = await retireAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({ error: "No such algo." });
  });

  it("falls back to a generic message for a non-API error", async () => {
    apiFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await retireAlgoAction(ALGO_ID, SLUG, {});

    expect(result).toEqual({ error: "Failed to retire this algo." });
  });
});

describe("refreshForwardEvidenceAction", () => {
  it("re-submits the same release/deployment pair the existing snapshot names", async () => {
    apiFetch.mockResolvedValueOnce(undefined);

    const result = await refreshForwardEvidenceAction(RELEASE_ID, DEPLOYMENT_ID, SLUG, {});

    expect(result).toEqual({});
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = apiFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe(`/v1/algo-releases/${RELEASE_ID}/stats`);
    expect(options.method).toBe("POST");
    // No scope, no backtestRunId — the discriminated union has no slot for
    // either on the FORWARD_DEPLOYMENT branch.
    expect(JSON.parse(options.body)).toEqual({ kind: "FORWARD_DEPLOYMENT", forwardDeploymentId: DEPLOYMENT_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/algos/${SLUG}`);
  });

  it("surfaces the API's own rejection reason", async () => {
    apiFetch.mockRejectedValueOnce(
      new MockApiError(422, { detail: "A PAUSED deployment has no result to publish." }),
    );

    const result = await refreshForwardEvidenceAction(RELEASE_ID, DEPLOYMENT_ID, SLUG, {});

    expect(result).toEqual({ error: "A PAUSED deployment has no result to publish." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for a non-API error", async () => {
    apiFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await refreshForwardEvidenceAction(RELEASE_ID, DEPLOYMENT_ID, SLUG, {});

    expect(result).toEqual({ error: "Failed to refresh forward evidence." });
  });
});
