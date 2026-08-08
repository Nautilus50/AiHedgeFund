import { describe, expect, it } from "vitest";
import { buildProblemDetails } from "./problem-details.js";

describe("buildProblemDetails", () => {
  it("builds the required RFC 9457 fields", () => {
    const problem = buildProblemDetails({
      status: 404,
      title: "Not Found",
      detail: "No campaign with that id.",
      instance: "/v1/campaigns/abc",
    });
    expect(problem).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No campaign with that id.",
      instance: "/v1/campaigns/abc",
    });
  });

  it("omits optional fields entirely when not provided (never serializes literal undefined)", () => {
    const problem = buildProblemDetails({ status: 400, title: "Bad Request", detail: "x", instance: "/v1/x" });
    expect("code" in problem).toBe(false);
    expect("traceId" in problem).toBe(false);
    expect("validationErrors" in problem).toBe(false);
  });

  it("includes code, traceId, and validationErrors when provided", () => {
    const problem = buildProblemDetails({
      status: 422,
      title: "Invalid Definition",
      detail: "x",
      instance: "/v1/x",
      code: "INVALID_DEFINITION",
      traceId: "trace-1",
      validationErrors: [{ path: "risk.sizePercent", message: "required" }],
    });
    expect(problem.code).toBe("INVALID_DEFINITION");
    expect(problem.traceId).toBe("trace-1");
    expect(problem.validationErrors).toEqual([{ path: "risk.sizePercent", message: "required" }]);
  });
});
