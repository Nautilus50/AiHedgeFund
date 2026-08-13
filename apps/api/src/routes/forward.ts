import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateForwardDeploymentInput } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import {
  completeForwardDeployment,
  createForwardDeployment,
  getForwardDeployment,
  getForwardDeploymentHealth,
  getForwardDrawdownCurve,
  getForwardEquityCurve,
  getForwardSignalEvents,
  pauseForwardDeployment,
  resumeForwardDeployment,
} from "../services/forward-deployments.js";
import { ingestTradingViewSignal } from "../services/forward-signals.js";
import { hashToken } from "../lib/tokens.js";

export interface ForwardRouteDeps {
  db: Database;
}

export function registerForwardRoutes(app: FastifyInstance, deps: ForwardRouteDeps): void {
  // Evidence/detail reads below all 404 rather than distinguish "not found"
  // from "belongs to another organisation" — CLAUDE.md 19.1.
  const notFound = (reply: FastifyReply, request: FastifyRequest, deploymentId: string) =>
    sendProblem(reply, { status: 404, title: "Not Found", detail: `No forward deployment ${deploymentId}.`, instance: request.url });

  app.post("/v1/forward-deployments", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "ADMIN"])) return;

    const parsed = CreateForwardDeploymentInput.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid forward deployment request",
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

    const result = await createForwardDeployment(deps.db, auth.organisationId, auth.userId, parsed.data);
    if (!result.ok) {
      const status = result.reasonCode === "STRATEGY_VERSION_NOT_FOUND" ? 404 : 422;
      sendProblem(reply, { status, title: "Deployment rejected", detail: result.message, instance: request.url, code: result.reasonCode });
      return;
    }

    // The plaintext token is the only response ever containing it — not
    // stored, not logged (CLAUDE.md 16.1, 19).
    const response = { deploymentId: result.deploymentId, token: result.token };
    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: response,
    });

    reply.code(201).send(response);
  });

  app.get("/v1/forward-deployments/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const deployment = await getForwardDeployment(deps.db, auth.organisationId, id);
    if (!deployment) return notFound(reply, request, id);

    reply.send(deployment);
  });

  const transitionRoute = (
    path: string,
    transition: (db: Database, organisationId: string, deploymentId: string) => ReturnType<typeof pauseForwardDeployment>,
  ) => {
    app.post(path, async (request, reply) => {
      const auth = request.requireAuth();
      if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "ADMIN"])) return;
      const { id } = request.params as { id: string };

      const idempotencyKey = requireIdempotencyKey(request, reply);
      if (!idempotencyKey) return;

      const idem = await checkIdempotency(deps.db, idempotencyKey, { deploymentId: id, path });
      if (idem.status === "CONFLICT") {
        sendProblem(reply, { status: 409, title: "Idempotency-Key conflict", detail: "Key reused with a different body.", instance: request.url });
        return;
      }
      if (idem.status === "REPLAY") {
        reply.code(200).send(idem.storedResponse);
        return;
      }

      const result = await transition(deps.db, auth.organisationId, id);
      if (!result.ok) {
        const status = result.reasonCode === "NOT_FOUND" ? 404 : 409;
        sendProblem(reply, { status, title: "Transition rejected", detail: result.message, instance: request.url, code: result.reasonCode });
        return;
      }

      await recordIdempotency(deps.db, {
        idempotencyKey,
        organisationId: auth.organisationId,
        requestBody: { deploymentId: id, path },
        responseBody: result,
      });

      reply.code(200).send(result);
    });
  };

  transitionRoute("/v1/forward-deployments/:id/pause", pauseForwardDeployment);
  // Not in the spec's literal endpoint list — added because a one-way pause
  // would be an operational trap (see forward-deployments.ts).
  transitionRoute("/v1/forward-deployments/:id/resume", resumeForwardDeployment);
  transitionRoute("/v1/forward-deployments/:id/complete", completeForwardDeployment);

  app.get("/v1/forward-deployments/:id/health", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const health = await getForwardDeploymentHealth(deps.db, auth.organisationId, id);
    if (!health) return notFound(reply, request, id);
    reply.send(health);
  });

  app.get("/v1/forward-deployments/:id/equity", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getForwardEquityCurve(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/forward-deployments/:id/drawdown", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getForwardDrawdownCurve(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/forward-deployments/:id/signals", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getForwardSignalEvents(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  const WebhookRateLimitConfig = {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: "1 minute",
        // Every organisation's TradingView alerts share the same small pool
        // of TradingView server IPs — IP-keying (the global default) would
        // pool every org's forward-test traffic into one shared budget.
        // Key by the token itself instead, so each deployment gets its own.
        keyGenerator: (request: FastifyRequest) => hashToken((request.params as { deploymentToken: string }).deploymentToken),
      },
    },
  };

  // No requireAuth() call — same non-pattern as the existing unauthenticated
  // /health route. The token itself is the auth (CLAUDE.md 16.1); TradingView
  // cannot send a Clerk session.
  app.post("/v1/webhooks/tradingview/:deploymentToken", WebhookRateLimitConfig, async (request, reply) => {
    const { deploymentToken } = request.params as { deploymentToken: string };

    const outcome = await ingestTradingViewSignal(deps.db, deploymentToken, request.body);

    switch (outcome.kind) {
      case "TOKEN_INVALID":
        sendProblem(reply, { status: 404, title: "Not Found", detail: "No deployment for this token.", instance: request.url });
        return;
      case "DEPLOYMENT_NOT_ACTIVE":
        sendProblem(reply, { status: 409, title: "Deployment not active", detail: "This deployment is not accepting signals.", instance: request.url });
        return;
      case "MALFORMED_PAYLOAD":
        sendProblem(reply, { status: 422, title: "Invalid signal payload", detail: "Request body failed SignalEvent validation.", instance: request.url });
        return;
      case "REJECTED":
        sendProblem(reply, {
          status: 422,
          title: "Signal rejected",
          detail: outcome.reasonCode,
          instance: request.url,
          code: outcome.reasonCode,
        });
        return;
      case "ACCEPTED":
        reply.code(202).send({ signalEventId: outcome.signalEventId, duplicate: outcome.duplicate });
        return;
    }
  });
}
