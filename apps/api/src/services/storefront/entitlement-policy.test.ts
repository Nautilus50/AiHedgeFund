import { describe, expect, it } from "vitest";
import { entitlementEffectFor, isEntitlementActive } from "./entitlement-policy.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");

describe("isEntitlementActive", () => {
  it("grants an active entitlement with no expiry", () => {
    expect(isEntitlementActive({ status: "ACTIVE", source: "SUBSCRIPTION", expiresAt: null }, NOW)).toBe(true);
  });

  it("grants up to the paid-through instant", () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    expect(isEntitlementActive({ status: "ACTIVE", source: "SUBSCRIPTION", expiresAt }, NOW)).toBe(true);
  });

  it("stops exactly at the paid-through instant", () => {
    expect(isEntitlementActive({ status: "ACTIVE", source: "SUBSCRIPTION", expiresAt: NOW }, NOW)).toBe(false);
  });

  it("denies a revoked entitlement even when unexpired", () => {
    const expiresAt = new Date(NOW.getTime() + 86_400_000);
    expect(isEntitlementActive({ status: "REVOKED", source: "SUBSCRIPTION", expiresAt }, NOW)).toBe(false);
  });
});

describe("entitlementEffectFor", () => {
  const periodEnd = new Date("2026-09-25T12:00:00.000Z");

  it("grants for an active subscription", () => {
    expect(entitlementEffectFor("ACTIVE", { cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd })).toEqual({
      action: "GRANT",
    });
  });

  it("grants until period end when cancellation is scheduled", () => {
    expect(entitlementEffectFor("ACTIVE", { cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd })).toEqual({
      action: "GRANT_UNTIL",
      expiresAt: periodEnd,
    });
  });

  it("revokes on cancellation", () => {
    expect(entitlementEffectFor("CANCELED", { cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd })).toEqual({
      action: "REVOKE",
    });
  });

  it("leaves a past-due subscription alone so dunning can recover it", () => {
    expect(entitlementEffectFor("PAST_DUE", { cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd })).toEqual({
      action: "LEAVE_UNCHANGED",
    });
  });

  it("never grants on an incomplete subscription", () => {
    expect(entitlementEffectFor("INCOMPLETE", { cancelAtPeriodEnd: false, currentPeriodEnd: null })).toEqual({
      action: "LEAVE_UNCHANGED",
    });
  });
});
