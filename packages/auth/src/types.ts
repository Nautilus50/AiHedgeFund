import type { OrganisationRole } from "@arf-os/contracts";

export interface AuthContext {
  /** Our internal users.id — never the Clerk subject directly. */
  userId: string;
  /** Our internal organisations.id — never the Clerk org id directly. */
  organisationId: string;
  role: OrganisationRole;
}

/**
 * A storefront buyer. Deliberately NOT an AuthContext: a customer has no
 * organisation and no research role, and no code path may treat one as the
 * other (ADR 0015). Anything organisation-scoped must reject a CustomerContext
 * by construction — it simply has no organisationId to check.
 */
export interface CustomerContext {
  userId: string;
}

export type AuthRejectionReason =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "NO_ORGANISATION_IN_TOKEN"
  | "UNKNOWN_ORGANISATION"
  | "UNKNOWN_USER"
  | "NOT_A_MEMBER_OF_ORGANISATION";

export interface AuthRejection {
  ok: false;
  reasonCode: AuthRejectionReason;
  message: string;
}

export type CustomerRejectionReason = "INVALID_TOKEN" | "UNKNOWN_USER";

export type CustomerResult =
  | { ok: true; context: CustomerContext }
  | { ok: false; reasonCode: CustomerRejectionReason; message: string };

export type AuthResult = { ok: true; context: AuthContext } | AuthRejection;
