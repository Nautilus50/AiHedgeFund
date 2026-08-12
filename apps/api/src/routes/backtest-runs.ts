import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import {
  getDrawdownCurve,
  getEquityCurve,
  getMetrics,
  getParityReports,
  getTrades,
  listBacktestRuns,
} from "../services/backtest-evidence.js";
import {
  createBacktestRun,
  datasetVersionBelongsToOrg,
  getBacktestRun,
  verificationMatchesVersion,
} from "../services/backtest-runs.js";
import { getStrategyVersion } from "../services/strategy-registry.js";

export interface BacktestRunRouteDeps {
  db: Database;
}

/**
 * Every field a result must be reproducible from is required, with no
 * defaults (CLAUDE.md 4). Defaulting the cost model or the capital would
 * quietly record assumptions the researcher never made.
 */
const CreateBacktestRunBody = z
  .object({
    strategyVersionId: z.string().uuid(),
    runnerType: z.enum(["LOCAL_RUNNER", "TRADINGVIEW"]),
    runnerVersion: z.string().min(1),
    verificationId: z.string().uuid().optional(),
    datasetVersionId: z.string().uuid().optional(),
    symbol: z.string().min(1),
    timeframe: z.string().min(1),
    segmentKind: z.string().min(1),
    fromTs: z.string().datetime(),
    toTs: z.string().datetime(),
    costModel: z.record(z.unknown()),
    // A string, not a number: capital is decimal money, and JSON numbers
    // are IEEE-754 doubles.
    initialCapital: z.string().regex(/^-?\d+(\.\d+)?$/),
    sourceHash: z.string().min(1),
    environmentHash: z.string().min(1).optional(),
  })
  .refine((body) => new Date(body.fromTs) < new Date(body.toTs), {
    message: "fromTs must be before toTs",
    path: ["fromTs"],
  })
  .refine((body) => body.runnerType !== "LOCAL_RUNNER" || body.datasetVersionId !== undefined, {
    message: "datasetVersionId is required for a LOCAL_RUNNER run — it has no other source of bar data.",
    path: ["datasetVersionId"],
  });

export function registerBacktestRunRoutes(app: FastifyInstance, deps: BacktestRunRouteDeps): void {
  app.post("/v1/backtest-runs", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "DEVELOPER", "ADMIN"])) return;

    const parsed = CreateBacktestRunBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid backtest run request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    // Ownership is resolved from the caller's organisation, never from a
    // body field (CLAUDE.md 19.1).
    const version = await getStrategyVersion(deps.db, auth.organisationId, parsed.data.strategyVersionId);
    if (!version) {
      sendProblem(reply, {
        status: 404,
        title: "Not Found",
        detail: `No strategy version ${parsed.data.strategyVersionId}.`,
        instance: request.url,
      });
      return;
    }

    if (parsed.data.verificationId) {
      const matches = await verificationMatchesVersion(
        deps.db,
        auth.organisationId,
        parsed.data.verificationId,
        parsed.data.strategyVersionId,
      );
      if (!matches) {
        sendProblem(reply, {
          status: 422,
          title: "Verification does not match strategy version",
          detail:
            "The verification must belong to this organisation and to the same strategy version as the run.",
          instance: request.url,
        });
        return;
      }
    }

    if (parsed.data.datasetVersionId) {
      const owned = await datasetVersionBelongsToOrg(deps.db, auth.organisationId, parsed.data.datasetVersionId);
      if (!owned) {
        sendProblem(reply, {
          status: 422,
          title: "Dataset version not found",
          detail: `No dataset version ${parsed.data.datasetVersionId} in this organisation.`,
          instance: request.url,
        });
        return;
      }
    }

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

    const result = await createBacktestRun(deps.db, {
      strategyVersionId: parsed.data.strategyVersionId,
      runnerType: parsed.data.runnerType,
      runnerVersion: parsed.data.runnerVersion,
      verificationId: parsed.data.verificationId,
      datasetVersionId: parsed.data.datasetVersionId,
      actor: auth.userId,
      symbol: parsed.data.symbol,
      timeframe: parsed.data.timeframe,
      segmentKind: parsed.data.segmentKind,
      fromTs: new Date(parsed.data.fromTs),
      toTs: new Date(parsed.data.toTs),
      costModel: parsed.data.costModel,
      initialCapital: parsed.data.initialCapital,
      sourceHash: parsed.data.sourceHash,
      environmentHash: parsed.data.environmentHash,
    });

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.get("/v1/backtest-runs/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const run = await getBacktestRun(deps.db, auth.organisationId, id);
    if (!run) {
      sendProblem(reply, {
        status: 404,
        title: "Not Found",
        detail: `No backtest run ${id}.`,
        instance: request.url,
      });
      return;
    }

    reply.send(run);
  });

  app.get("/v1/strategy-versions/:id/backtest-runs", async (request, reply) => {
    const auth = request.requireAuth();
    const { id: strategyVersionId } = request.params as { id: string };
    const query = request.query as { cursor?: string; limit?: string };

    const result = await listBacktestRuns(deps.db, auth.organisationId, {
      strategyVersionId,
      cursor: query.cursor,
      limit: query.limit ? Number(query.limit) : undefined,
    });

    if (!result.ok) {
      sendProblem(reply, {
        status: 400,
        title: "Invalid cursor",
        detail: "The cursor query parameter is malformed.",
        instance: request.url,
      });
      return;
    }

    reply.send(result.page);
  });

  // Evidence reads below all 404 rather than distinguish "run not found"
  // from "run belongs to another organisation" — CLAUDE.md 19.1: never let
  // a caller learn whether an id exists outside their own organisation.
  const notFound = (reply: FastifyReply, request: FastifyRequest, backtestRunId: string) =>
    sendProblem(reply, {
      status: 404,
      title: "Not Found",
      detail: `No backtest run ${backtestRunId}.`,
      instance: request.url,
    });

  app.get("/v1/backtest-runs/:id/trades", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getTrades(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/backtest-runs/:id/equity", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getEquityCurve(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/backtest-runs/:id/drawdown", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getDrawdownCurve(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/backtest-runs/:id/metrics", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getMetrics(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });

  app.get("/v1/backtest-runs/:id/parity", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };
    const result = await getParityReports(deps.db, auth.organisationId, id);
    if (!result) return notFound(reply, request, id);
    reply.send({ items: result });
  });
}
