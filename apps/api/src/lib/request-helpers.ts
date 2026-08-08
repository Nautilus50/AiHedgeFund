import type { FastifyReply, FastifyRequest } from "fastify";
import type { OrganisationRole } from "@arf-os/contracts";
import { hasRequiredRole } from "@arf-os/auth";
import { sendProblem } from "./problem-details.js";

/** Sends a 400 and returns undefined when the header is missing/empty; otherwise returns the key. */
export function requireIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    sendProblem(reply, {
      status: 400,
      title: "Missing Idempotency-Key",
      detail: "This command requires an Idempotency-Key header.",
      instance: request.url,
    });
    return undefined;
  }
  return key;
}

/** Sends a 403 and returns false when the actor's role isn't permitted; otherwise returns true. */
export function requireRoleOr403(
  request: FastifyRequest,
  reply: FastifyReply,
  actorRole: OrganisationRole,
  allowed: readonly OrganisationRole[],
): boolean {
  if (hasRequiredRole(actorRole, allowed)) {
    return true;
  }
  sendProblem(reply, {
    status: 403,
    title: "Forbidden",
    detail: `Requires one of: ${allowed.join(", ")}.`,
    instance: request.url,
    code: "ROLE_NOT_PERMITTED",
  });
  return false;
}
