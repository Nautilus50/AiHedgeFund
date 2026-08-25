import { describe, expect, it } from "vitest";
import { resolveAuthContext, resolveCustomerContext } from "./context.js";

const claims = { subject: "user_clerk123", clerkOrganisationId: "org_clerk456" };
const userLookup = { id: "internal-user-1" };
const organisationLookup = { id: "internal-org-1" };
const membership = { userId: "internal-user-1", organisationId: "internal-org-1", role: "RESEARCHER" as const };

describe("resolveAuthContext", () => {
  it("succeeds when user, organisation, and membership all line up", () => {
    const result = resolveAuthContext(claims, userLookup, organisationLookup, membership);
    expect(result).toEqual({
      ok: true,
      context: { userId: "internal-user-1", organisationId: "internal-org-1", role: "RESEARCHER" },
    });
  });

  it("rejects a session with no organisation claim", () => {
    const result = resolveAuthContext({ subject: "user_clerk123" }, userLookup, organisationLookup, membership);
    expect(result).toMatchObject({ ok: false, reasonCode: "NO_ORGANISATION_IN_TOKEN" });
  });

  it("rejects when no ARF-OS user is linked to the Clerk subject", () => {
    const result = resolveAuthContext(claims, undefined, organisationLookup, membership);
    expect(result).toMatchObject({ ok: false, reasonCode: "UNKNOWN_USER" });
  });

  it("rejects when no ARF-OS organisation is linked to the Clerk org", () => {
    const result = resolveAuthContext(claims, userLookup, undefined, membership);
    expect(result).toMatchObject({ ok: false, reasonCode: "UNKNOWN_ORGANISATION" });
  });

  it("rejects when the user has no membership row for this organisation", () => {
    const result = resolveAuthContext(claims, userLookup, organisationLookup, undefined);
    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_A_MEMBER_OF_ORGANISATION" });
  });

  it("rejects a membership that belongs to a different user (never trust a stale/mismatched lookup)", () => {
    const wrongMembership = { ...membership, userId: "someone-else" };
    const result = resolveAuthContext(claims, userLookup, organisationLookup, wrongMembership);
    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_A_MEMBER_OF_ORGANISATION" });
  });

  it("rejects a membership that belongs to a different organisation", () => {
    const wrongMembership = { ...membership, organisationId: "some-other-org" };
    const result = resolveAuthContext(claims, userLookup, organisationLookup, wrongMembership);
    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_A_MEMBER_OF_ORGANISATION" });
  });
});

describe("resolveCustomerContext", () => {
  it("authenticates a personal (org-less) session", () => {
    const result = resolveCustomerContext({ subject: "user_1" }, { id: "11111111-1111-4111-8111-111111111111" });
    expect(result).toEqual({ ok: true, context: { userId: "11111111-1111-4111-8111-111111111111" } });
  });

  it("ignores the organisation claim entirely", () => {
    const result = resolveCustomerContext(
      { subject: "user_1", clerkOrganisationId: "org_1" },
      { id: "11111111-1111-4111-8111-111111111111" },
    );
    expect(result.ok).toBe(true);
    // A customer context carries no organisation or role — nothing downstream
    // can mistake a buyer for a member of the operating organisation.
    if (result.ok) {
      expect(Object.keys(result.context)).toEqual(["userId"]);
    }
  });

  it("rejects a subject with no user row", () => {
    const result = resolveCustomerContext({ subject: "user_unknown" }, undefined);
    expect(result).toMatchObject({ ok: false, reasonCode: "UNKNOWN_USER" });
  });
});
