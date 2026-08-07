import { describe, expect, it } from "vitest";
import { hasRequiredRole, requireRole } from "./rbac.js";

describe("hasRequiredRole", () => {
  it("allows an exact role match", () => {
    expect(hasRequiredRole("VALIDATOR", ["VALIDATOR", "OPERATOR"])).toBe(true);
  });

  it("rejects a role that is not in the allowed list", () => {
    expect(hasRequiredRole("VIEWER", ["VALIDATOR", "OPERATOR"])).toBe(false);
  });

  it("lets ADMIN bypass any role check", () => {
    expect(hasRequiredRole("ADMIN", ["COMMITTEE_MEMBER"])).toBe(true);
  });

  it("does not implicitly grant COMMITTEE_MEMBER powers to any other role", () => {
    expect(hasRequiredRole("OPERATOR", ["COMMITTEE_MEMBER"])).toBe(false);
  });
});

describe("requireRole", () => {
  it("returns ok:true for a permitted role", () => {
    expect(requireRole("DEVELOPER", ["DEVELOPER"])).toEqual({ ok: true });
  });

  it("returns a typed rejection for a forbidden role, not a thrown error", () => {
    const result = requireRole("VIEWER", ["ADMIN"]);
    expect(result).toMatchObject({ ok: false, reasonCode: "ROLE_NOT_PERMITTED" });
  });
});
