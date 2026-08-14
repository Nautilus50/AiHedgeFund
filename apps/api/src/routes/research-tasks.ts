import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { listResearchTasks, submitResearchTask } from "../services/research-tasks.js";

export interface ResearchTaskRouteDeps {
  db: Database;
}

const CreateResearchTaskBody = z.object({
  role: z.string().min(1),
  objective: z.string().min(1),
});

export function registerResearchTaskRoutes(app: FastifyInstance, deps: ResearchTaskRouteDeps): void {
  app.post("/v1/campaigns/:id/research-tasks", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "OPERATOR", "ADMIN"])) return;

    const { id: campaignId } = request.params as { id: string };

    const parsed = CreateResearchTaskBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid research task request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    const idem = await checkIdempotency(deps.db, idempotencyKey, parsed.data);
    if (idem.status === "CONFLICT") {
      sendProblem(reply, {
        status: 409,
        title: "Idempotency-Key conflict",
        detail: "Key reused with a different body.",
        instance: request.url,
      });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const outcome = await submitResearchTask(deps.db, {
      organisationId: auth.organisationId,
      campaignId,
      role: parsed.data.role,
      objective: parsed.data.objective,
      actor: auth.userId,
    });

    if (!outcome.ok) {
      if (outcome.reasonCode === "CAMPAIGN_NOT_FOUND") {
        sendProblem(reply, {
          status: 404,
          title: "Not Found",
          detail: `No campaign ${campaignId}.`,
          instance: request.url,
        });
        return;
      }
      // ROLE_NOT_REGISTERED: validated against only the roles this runtime
      // can actually run (AGENT_RUNTIME_REGISTRY), not the full 11-member
      // AgentRole enum — a role with no worker implementation must 422
      // here, not create a row and fail deep inside the worker (ADR 0008).
      sendProblem(reply, {
        status: 422,
        title: "Role not available",
        detail: `Role ${parsed.data.role} has no agent runtime implementation yet.`,
        instance: request.url,
      });
      return;
    }

    const result = { researchTaskId: outcome.researchTaskId };

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.get("/v1/campaigns/:id/research-tasks", async (request, reply) => {
    const auth = request.requireAuth();
    const { id: campaignId } = request.params as { id: string };

    const result = await listResearchTasks(deps.db, auth.organisationId, campaignId);
    if (!result) {
      sendProblem(reply, {
        status: 404,
        title: "Not Found",
        detail: `No campaign ${campaignId}.`,
        instance: request.url,
      });
      return;
    }

    reply.send({ items: result });
  });
}
