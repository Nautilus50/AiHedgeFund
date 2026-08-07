import { createClerkClient, verifyToken } from "@clerk/backend";
import type { ClerkClaims } from "./context.js";

export interface ClerkConfig {
  secretKey: string;
  publishableKey?: string;
}

/** Thin wrapper so callers never import `@clerk/backend` directly (CLAUDE.md 11.1 — provider adapters must not leak into workflow logic). */
export function createAuthClient(config: ClerkConfig): ReturnType<typeof createClerkClient> {
  return createClerkClient(
    config.publishableKey === undefined
      ? { secretKey: config.secretKey }
      : { secretKey: config.secretKey, publishableKey: config.publishableKey },
  );
}

/**
 * Verifies a Clerk session JWT and extracts the two claims this service
 * cares about. Returns undefined on any verification failure — expired,
 * malformed, wrong-audience, or signed by a different Clerk instance —
 * rather than throwing, so callers can uniformly treat "no valid claims" as
 * unauthenticated (CLAUDE.md 19.5 — treat all external input as untrusted).
 */
export async function verifyClerkToken(token: string, secretKey: string): Promise<ClerkClaims | undefined> {
  try {
    const payload = await verifyToken(token, { secretKey });
    return {
      subject: payload.sub,
      clerkOrganisationId: typeof payload.org_id === "string" ? payload.org_id : undefined,
    };
  } catch {
    return undefined;
  }
}
