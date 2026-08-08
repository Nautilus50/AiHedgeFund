import { describe, expect, it } from "vitest";
import { extractOrganisationId } from "./clerk-client.js";

describe("extractOrganisationId", () => {
  it("reads the flat org_id claim from a legacy (v1, no `v`) token", () => {
    expect(extractOrganisationId({ sub: "user_1", org_id: "org_legacy" })).toBe("org_legacy");
  });

  it("reads the nested o.id claim from a v2 token — the format real Clerk instances issue today", () => {
    const payload = {
      sub: "user_1",
      v: 2,
      o: { id: "org_3HeJ09bFxKWWJh0Q2xMyBnmwaG6", slg: "my-org", rol: "admin" },
    };
    expect(extractOrganisationId(payload)).toBe("org_3HeJ09bFxKWWJh0Q2xMyBnmwaG6");
  });

  it("returns undefined when the session has no active organisation (personal account context)", () => {
    expect(extractOrganisationId({ sub: "user_1", v: 2 })).toBeUndefined();
  });

  it("returns undefined for a completely bare payload", () => {
    expect(extractOrganisationId({ sub: "user_1" })).toBeUndefined();
  });

  it("prefers the flat org_id if somehow both are present", () => {
    const payload = { org_id: "org_flat", o: { id: "org_nested" } };
    expect(extractOrganisationId(payload)).toBe("org_flat");
  });
});
