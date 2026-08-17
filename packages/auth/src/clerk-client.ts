import { createClerkClient, verifyToken } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import type { WebhookEvent, OrganizationMembershipJSON } from "@clerk/backend";
import type { ClerkClaims } from "./context.js";

/** Re-exported so callers (apps/api) never import `@clerk/backend` themselves (CLAUDE.md 11.1). */
export type { WebhookEvent, OrganizationMembershipJSON };

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
 * Clerk's JWT payload is a discriminated union on `v`: legacy tokens (no `v`)
 * carry the active org id in a flat `org_id` claim, but `v: 2` tokens (what
 * Clerk actually issues today) nest it under `o.id` instead and type
 * `org_id` as `never`. Reading only `org_id` silently drops the org on
 * every current-format token — this extracts whichever shape is present.
 */
export function extractOrganisationId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.org_id === "string") {
    return payload.org_id;
  }
  const nested = payload.o;
  if (nested && typeof nested === "object" && "id" in nested && typeof nested.id === "string") {
    return nested.id;
  }
  return undefined;
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
      clerkOrganisationId: extractOrganisationId(payload),
    };
  } catch {
    return undefined;
  }
}

/**
 * Verifies a Clerk webhook request's `svix-*` signature headers against the
 * raw request body. Wraps `@clerk/backend/webhooks`'s `verifyWebhook` (which
 * itself wraps `svix`) so `apps/api` never imports `@clerk/backend` directly
 * (CLAUDE.md 11.1), mirroring `verifyClerkToken`'s exact shape: swallow any
 * verification failure — bad signature, expired timestamp, malformed body —
 * and return `undefined` rather than throw, so callers uniformly treat "not
 * verified" as untrusted input (CLAUDE.md 19.5).
 */
export async function verifyClerkWebhook(request: Request, signingSecret: string): Promise<WebhookEvent | undefined> {
  try {
    return await verifyWebhook(request, { signingSecret });
  } catch {
    return undefined;
  }
}
