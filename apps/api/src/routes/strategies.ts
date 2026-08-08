import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import type { WorkflowService } from "@arf-os/workflow";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { RecordDecisionInput, recordCommitteeDecision } from "../services/decisions.js";
import { getAuditTimeline } from "../services/audit.js";
import {
  createChildStrategyVersion,
  createStrategy,
  getStrategyLineage,
  getStrategyVersion,
  saveStrategyDefinition,
  savePineRevision,
} from "../services/strategy-registry.js";

export interface StrategyRouteDeps {
  db: Database;
  workflow: WorkflowService;
}

const CreateStrategyBody = z.object({
  campaignId: z.string().uuid(),
  name: z.string().min(1).max(255),
});

const CreateChildVersionBody = z.object({
  parentVersionId: z.string().uuid(),
  changeCategory: z.string().min(1),
  changedFields: z.array(z.string()).default([]),
  motivatingEvidenceIds: z.array(z.string().uuid()).default([]),
  changeReason: z.string().min(1),
});

const SavePineRevisionBody = z.object({
  source: z.string().min(1),
  manifest: z.unknown(),
});

export function registerStrategyRoutes(app: FastifyInstance, deps: StrategyRouteDeps): void {
  app.post("/v1/strategies", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "DEVELOPER", "ADMIN"])) return;

    const parsed = CreateStrategyBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid strategy",
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
      sendProblem(reply, { status: 409, title: "Idempotency-Key conflict", detail: "Key reused with a different body.", instance: request.url });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const result = await createStrategy(deps.db, {
      organisationId: auth.organisationId,
      campaignId: parsed.data.campaignId,
      name: parsed.data.name,
    });

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.post("/v1/strategies/:id/versions", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "DEVELOPER", "ADMIN"])) return;
    const { id: strategyId } = request.params as { id: string };

    const parsed = CreateChildVersionBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid strategy version",
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
      sendProblem(reply, { status: 409, title: "Idempotency-Key conflict", detail: "Key reused with a different body.", instance: request.url });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const result = await createChildStrategyVersion(deps.db, { strategyId, ...parsed.data });

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.get("/v1/strategy-versions/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const version = await getStrategyVersion(deps.db, auth.organisationId, id);
    if (!version) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No strategy version ${id}.`, instance: request.url });
      return;
    }

    reply.send(version);
  });

  app.get("/v1/strategy-versions/:id/lineage", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    reply.send(await getStrategyLineage(deps.db, auth.organisationId, id));
  });

  app.put("/v1/strategy-versions/:id/definition", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "DEVELOPER", "ADMIN"])) return;
    const { id } = request.params as { id: string };

    const result = await saveStrategyDefinition(deps.db, { strategyVersionId: id, definition: request.body });
    if (!result.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid strategy definition",
        detail: "SDL failed schema validation.",
        instance: request.url,
        code: result.reasonCode,
        validationErrors: result.issues,
      });
      return;
    }

    reply.code(200).send(result);
  });

  app.put("/v1/strategy-versions/:id/pine", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["DEVELOPER", "ADMIN"])) return;
    const { id } = request.params as { id: string };

    const parsed = SavePineRevisionBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid Pine revision",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const result = await savePineRevision(deps.db, {
      strategyVersionId: id,
      source: parsed.data.source,
      manifest: parsed.data.manifest,
      createdByUserId: auth.userId,
    });

    reply.code(200).send(result);
  });

  app.post("/v1/strategy-versions/:id/decisions", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["COMMITTEE_MEMBER", "ADMIN"])) return;
    const { id } = request.params as { id: string };

    const parsed = RecordDecisionInput.omit({ strategyVersionId: true }).safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid decision",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    const fullInput = { strategyVersionId: id, ...parsed.data };

    const idem = await checkIdempotency(deps.db, idempotencyKey, fullInput);
    if (idem.status === "CONFLICT") {
      sendProblem(reply, { status: 409, title: "Idempotency-Key conflict", detail: "Key reused with a different body.", instance: request.url });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const result = await recordCommitteeDecision(
      deps.db,
      deps.workflow,
      { id: auth.userId, roles: [auth.role] },
      idempotencyKey,
      fullInput,
    );

    if (!result.ok) {
      sendProblem(reply, {
        status: 409,
        title: "Decision rejected by workflow policy",
        detail: result.message,
        instance: request.url,
        code: result.reasonCode,
      });
      return;
    }

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: fullInput,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.get("/v1/strategy-versions/:id/audit", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const events = await getAuditTimeline(deps.db, {
      organisationId: auth.organisationId,
      aggregateType: "strategy_version",
      aggregateId: id,
    });

    reply.send(events);
  });
}
