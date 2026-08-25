import type { OrganisationRole } from "@arf-os/contracts";

export interface AuthContext {
  /** Our internal users.id — never the Clerk subject directly. */
  userId: string;
  /** Our internal organisations.id — never the Clerk org id directly. */
  organisationId: string;
  role: OrganisationRole;
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

export type AuthResult = { ok: true; context: AuthContext } | AuthRejection;
