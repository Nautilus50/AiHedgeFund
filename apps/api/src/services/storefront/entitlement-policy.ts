import type { EntitlementSource, EntitlementStatus, SubscriptionStatus } from "@arf-os/contracts";

/**
 * Deterministic entitlement rules (CLAUDE.md 3.7 — gates live in application
 * code, never in a prompt or a UI condition). Both functions are pure so the
 * question "may this person read this algo's source right now?" has exactly one
 * testable answer.
 */

export interface EntitlementRecord {
  status: EntitlementStatus;
  source: EntitlementSource;
  expiresAt: Date | null;
}

/**
 * An entitlement grants access only while it is ACTIVE and unexpired. `expiresAt`
 * is the end of a period already paid for, so access continues up to that
 * instant and stops exactly at it.
 */
export function isEntitlementActive(entitlement: EntitlementRecord, now: Date): boolean {
  if (entitlement.status !== "ACTIVE") return false;
  if (entitlement.expiresAt && entitlement.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export type EntitlementEffect =
  | { action: "GRANT" }
  /** Paid through `expiresAt`, then access ends. Used for cancel-at-period-end. */
  | { action: "GRANT_UNTIL"; expiresAt: Date }
  | { action: "REVOKE" }
  | { action: "LEAVE_UNCHANGED" };

/**
 * Maps a provider subscription state onto the entitlement effect it should
 * have.
 *
 * PAST_DUE deliberately leaves access unchanged: a failed card retry is a
 * billing problem, not a licence breach, and the provider's dunning cycle ends
 * in either a recovered payment or a CANCELED event that revokes properly.
 */
export function entitlementEffectFor(
  status: SubscriptionStatus,
  options: { cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null },
): EntitlementEffect {
  switch (status) {
    case "ACTIVE":
      if (options.cancelAtPeriodEnd && options.currentPeriodEnd) {
        return { action: "GRANT_UNTIL", expiresAt: options.currentPeriodEnd };
      }
      return { action: "GRANT" };
    case "PAST_DUE":
      return { action: "LEAVE_UNCHANGED" };
    case "CANCELED":
      return { action: "REVOKE" };
    case "INCOMPLETE":
      // Nothing has been paid yet. An incomplete subscription must never be
      // the thing that hands over source code.
      return { action: "LEAVE_UNCHANGED" };
  }
}
