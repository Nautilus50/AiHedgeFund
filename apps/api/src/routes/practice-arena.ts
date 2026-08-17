import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import {
  benchmarkTaskBelongsToOrg,
  createPracticeRun,
  listBenchmarkTasks,
  listPracticeRuns,
  listPromptsForRole,
  reviewPracticeRun,
  submitBenchmarkTask,
} from "../services/practice-arena.js";

export interface PracticeArenaRouteDeps {
  db: Database;
}

const CreateBenchmarkTaskBody = z.object({
  role: z.string().min(1),
  objective: z.string().min(1),
  visibility: z.enum(["VISIBLE", "HIDDEN"]).default("VISIBLE"),
});

const CreatePracticeRunBody = z.object({
  promptId: z.string().uuid(),
});

const ReviewPracticeRunBody = z.object({
  score: z.number().min(0).max(1),
  notes: z.string().optional(),
});

export function registerPracticeArenaRoutes(app: FastifyInstance, deps: PracticeArenaRouteDeps): void {
  app.post("/v1/benchmark-tasks", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "OPERATOR", "ADMIN"])) return;

    const parsed = CreateBenchmarkTaskBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid benchmark task request",
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

    const outcome = await submitBenchmarkTask(deps.db, {
      organisationId: auth.organisationId,
      role: parsed.data.role,
      objective: parsed.data.objective,
      visibility: parsed.data.visibility,
      createdByUserId: auth.userId,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Role not available",
        detail: `Role ${parsed.data.role} has no agent runtime implementation yet.`,
        instance: request.url,
      });
      return;
    }

    const result = { benchmarkTaskId: outcome.benchmarkTaskId };
    await recordIdempotency(deps.db, { idempotencyKey, organisationId: auth.organisationId, requestBody: parsed.data, responseBody: result });
    reply.code(201).send(result);
  });

  app.get("/v1/benchmark-tasks", async (request, reply) => {
    const auth = request.requireAuth();
    const result = await listBenchmarkTasks(deps.db, auth.organisationId, auth.userId);
    reply.send({ items: result });
  });

  app.get("/v1/benchmark-tasks/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id: benchmarkTaskId } = request.params as { id: string };

    const result = await benchmarkTaskBelongsToOrg(deps.db, auth.organisationId, benchmarkTaskId);
    if (!result) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No benchmark task ${benchmarkTaskId}.`, instance: request.url });
      return;
    }
    reply.send(result);
  });

  app.post("/v1/benchmark-tasks/:id/practice-runs", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "OPERATOR", "ADMIN"])) return;

    const { id: benchmarkTaskId } = request.params as { id: string };

    const parsed = CreatePracticeRunBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid practice run request",
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

    const outcome = await createPracticeRun(deps.db, {
      organisationId: auth.organisationId,
      benchmarkTaskId,
      promptId: parsed.data.promptId,
      actor: auth.userId,
    });

    if (!outcome.ok) {
      const status = outcome.reasonCode === "BENCHMARK_TASK_NOT_FOUND" || outcome.reasonCode === "PROMPT_NOT_FOUND" ? 404 : 422;
      sendProblem(reply, {
        status,
        title: outcome.reasonCode === "PROMPT_ROLE_MISMATCH" ? "Prompt role mismatch" : "Not Found",
        detail:
          outcome.reasonCode === "PROMPT_ROLE_MISMATCH"
            ? "The chosen prompt's role does not match this benchmark task's role."
            : `${outcome.reasonCode === "BENCHMARK_TASK_NOT_FOUND" ? "No benchmark task" : "No prompt"} ${outcome.reasonCode === "BENCHMARK_TASK_NOT_FOUND" ? benchmarkTaskId : parsed.data.promptId}.`,
        instance: request.url,
      });
      return;
    }

    const result = { practiceRunId: outcome.practiceRunId };
    await recordIdempotency(deps.db, { idempotencyKey, organisationId: auth.organisationId, requestBody: parsed.data, responseBody: result });
    reply.code(201).send(result);
  });

  app.get("/v1/benchmark-tasks/:id/practice-runs", async (request, reply) => {
    const auth = request.requireAuth();
    const { id: benchmarkTaskId } = request.params as { id: string };

    const result = await listPracticeRuns(deps.db, auth.organisationId, benchmarkTaskId);
    if (!result) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No benchmark task ${benchmarkTaskId}.`, instance: request.url });
      return;
    }
    reply.send({ items: result });
  });

  app.post("/v1/practice-runs/:id/review", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["VALIDATOR", "ADMIN"])) return;

    const { id: practiceRunId } = request.params as { id: string };

    const parsed = ReviewPracticeRunBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid review request",
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

    const outcome = await reviewPracticeRun(deps.db, {
      organisationId: auth.organisationId,
      practiceRunId,
      score: parsed.data.score,
      notes: parsed.data.notes,
      reviewerUserId: auth.userId,
    });

    if (!outcome.ok) {
      if (outcome.reasonCode === "PRACTICE_RUN_NOT_FOUND") {
        sendProblem(reply, { status: 404, title: "Not Found", detail: `No practice run ${practiceRunId}.`, instance: request.url });
        return;
      }
      sendProblem(reply, {
        status: 422,
        title: "Practice run not reviewable",
        detail: "Only a SUCCEEDED practice run can be reviewed.",
        instance: request.url,
      });
      return;
    }

    const result = { reviewed: true };
    await recordIdempotency(deps.db, { idempotencyKey, organisationId: auth.organisationId, requestBody: parsed.data, responseBody: result });
    reply.code(200).send(result);
  });

  app.get("/v1/prompts", async (request, reply) => {
    request.requireAuth();
    const { role } = request.query as { role?: string };
    if (!role) {
      sendProblem(reply, { status: 422, title: "Missing role", detail: "The role query parameter is required.", instance: request.url });
      return;
    }

    const result = await listPromptsForRole(deps.db, role);
    reply.send({ items: result });
  });
}
