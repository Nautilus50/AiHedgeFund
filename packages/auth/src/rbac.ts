import type { OrganisationRole } from "@arf-os/contracts";

/**
 * ADMIN always satisfies any role check; every other role must match one of
 * the explicitly allowed roles (no implicit hierarchy — CLAUDE.md 8: "Use
 * explicit enum values. Do not silently coerce invalid values.").
 */
export function hasRequiredRole(actorRole: OrganisationRole, allowed: readonly OrganisationRole[]): boolean {
  if (actorRole === "ADMIN") return true;
  return allowed.includes(actorRole);
}

export type RoleCheckResult = { ok: true } | { ok: false; reasonCode: "ROLE_NOT_PERMITTED"; message: string };

export function requireRole(actorRole: OrganisationRole, allowed: readonly OrganisationRole[]): RoleCheckResult {
  if (hasRequiredRole(actorRole, allowed)) {
    return { ok: true };
  }
  return {
    ok: false,
    reasonCode: "ROLE_NOT_PERMITTED",
    message: `Requires one of: ${allowed.join(", ")} (actor has ${actorRole}).`,
  };
}
