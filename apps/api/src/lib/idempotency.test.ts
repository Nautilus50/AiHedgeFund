import { fingerprint } from "@arf-os/contracts";
import { describe, expect, it } from "vitest";
import { evaluateIdempotency } from "./idempotency.js";

describe("evaluateIdempotency", () => {
  it("is FRESH when there is no stored record", () => {
    expect(evaluateIdempotency(undefined, fingerprint({ a: 1 }))).toEqual({ status: "FRESH" });
  });

  it("is a REPLAY when the stored request matches exactly", () => {
    const body = { name: "Campaign A" };
    const existing = { requestHash: fingerprint(body), responseBody: { id: "camp-1" } };
    expect(evaluateIdempotency(existing, fingerprint(body))).toEqual({
      status: "REPLAY",
      storedResponse: { id: "camp-1" },
    });
  });

  it("is a CONFLICT when the same key was used for a different body", () => {
    const existing = { requestHash: fingerprint({ name: "Campaign A" }), responseBody: { id: "camp-1" } };
    const result = evaluateIdempotency(existing, fingerprint({ name: "Campaign B" }));
    expect(result).toEqual({ status: "CONFLICT" });
  });

  it("treats key order in the request body as irrelevant to the match", () => {
    const existing = { requestHash: fingerprint({ a: 1, b: 2 }), responseBody: {} };
    expect(evaluateIdempotency(existing, fingerprint({ b: 2, a: 1 }))).toMatchObject({ status: "REPLAY" });
  });
});
