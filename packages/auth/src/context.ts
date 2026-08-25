import type { OrganisationRole } from "@arf-os/contracts";
import type { AuthResult, CustomerResult } from "./types.js";

export interface ClerkClaims {
  /** Clerk user id (JWT `sub`). */
  subject: string;
  /** Clerk organization id (JWT `org_id`), present only when the session is org-scoped. */
  clerkOrganisationId?: string | undefined;
}

export interface MembershipLookup {
  userId: string;
  organisationId: string;
  role: OrganisationRole;
}

/**
 * Pure decision: given verified Clerk claims and the internal user/org/
 * membership rows a caller already looked up, decide whether the request is
 * authenticated and organisation-scoped. Contains no I/O itself — token
 * verification and database lookups are the caller's job (packages/auth's
 * Fastify plugin), which keeps this function fully unit-testable
 * (CLAUDE.md 19.1 — "Never trust client-supplied organisation IDs without
 * membership checks").
 */
export function resolveAuthContext(
  claims: ClerkClaims,
  userLookup: { id: string } | undefined,
  organisationLookup: { id: string } | undefined,
  membership: MembershipLookup | undefined,
): AuthResult {
  if (!claims.clerkOrganisationId) {
    return {
      ok: false,
      reasonCode: "NO_ORGANISATION_IN_TOKEN",
      message: "Session token is not scoped to a Clerk organization.",
    };
  }

  if (!userLookup) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_USER",
      message: `No ARF-OS user is linked to Clerk subject ${claims.subject}.`,
    };
  }

  if (!organisationLookup) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_ORGANISATION",
      message: `No ARF-OS organisation is linked to Clerk organization ${claims.clerkOrganisationId}.`,
    };
  }

  if (!membership || membership.userId !== userLookup.id || membership.organisationId !== organisationLookup.id) {
    return {
      ok: false,
      reasonCode: "NOT_A_MEMBER_OF_ORGANISATION",
      message: "User is not a member of the requested organisation.",
    };
  }

  return {
    ok: true,
    context: { userId: membership.userId, organisationId: membership.organisationId, role: membership.role },
  };
}

/**
 * Pure decision for the storefront's buyer identity: a verified Clerk subject
 * that maps to a known user. Unlike resolveAuthContext this deliberately does
 * not look at `org_id` — a buyer signs in with a personal account, and a
 * researcher's org-scoped token authenticates them here only as the person
 * they are, never with their research role.
 */
export function resolveCustomerContext(
  claims: ClerkClaims,
  userLookup: { id: string } | undefined,
): CustomerResult {
  if (!userLookup) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_USER",
      message: `No user is linked to Clerk subject ${claims.subject}.`,
    };
  }
  return { ok: true, context: { userId: userLookup.id } };
}
