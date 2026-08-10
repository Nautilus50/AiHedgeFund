import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { getBacktestRun } from "../services/backtest-runs.js";
import {
  createReportUploadIntent,
  createTradingViewVerification,
  completeReportUpload,
  getReportUploadsForVerification,
  getVerification,
} from "../services/verification.js";

export interface VerificationRouteDeps {
  db: Database;
  s3: S3Client;
  bucket: string;
}

const CreateVerificationBody = z.object({
  strategyVersionId: z.string().uuid(),
  requiredSymbol: z.string().min(1),
  requiredTimeframe: z.string().min(1),
});

const ReportKindSchema = z.enum(["PERFORMANCE_SUMMARY", "LIST_OF_TRADES"]);

const CreateUploadIntentBody = z.object({ kind: ReportKindSchema });
const CompleteUploadBody = z.object({
  kind: ReportKindSchema,
  objectKey: z.string().min(1),
  /**
   * Supplying the run this ledger belongs to is what starts normalisation.
   * Optional so a summary — or a ledger uploaded before its run exists —
   * still gets stored as evidence.
   */
  backtestRunId: z.string().uuid().optional(),
});

export function registerVerificationRoutes(app: FastifyInstance, deps: VerificationRouteDeps): void {
  app.post("/v1/verifications", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "DEVELOPER", "ADMIN"])) return;

    const parsed = CreateVerificationBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid verification request",
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

    const result = await createTradingViewVerification(deps.db, {
      strategyVersionId: parsed.data.strategyVersionId,
      requiredSymbol: parsed.data.requiredSymbol,
      requiredTimeframe: parsed.data.requiredTimeframe,
      requestedByUserId: auth.userId,
    });

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });

  app.get("/v1/verifications/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const verification = await getVerification(deps.db, auth.organisationId, id);
    if (!verification) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No verification ${id}.`, instance: request.url });
      return;
    }

    const uploads = await getReportUploadsForVerification(deps.db, id);
    reply.send({ ...verification, uploads });
  });

  app.post("/v1/verifications/:id/uploads", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "DEVELOPER", "ADMIN"])) return;
    const { id } = request.params as { id: string };

    const parsed = CreateUploadIntentBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid upload request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const verification = await getVerification(deps.db, auth.organisationId, id);
    if (!verification) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No verification ${id}.`, instance: request.url });
      return;
    }

    const presigned = await createReportUploadIntent(deps.s3, deps.bucket, {
      organisationId: verification.organisationId,
      campaignId: verification.campaignId,
      strategyId: verification.strategyId,
      strategyVersionId: verification.strategyVersionId,
      verificationId: verification.id,
      kind: parsed.data.kind,
    });

    reply.code(201).send(presigned);
  });

  app.post("/v1/verifications/:id/uploads/complete", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["OPERATOR", "DEVELOPER", "ADMIN"])) return;
    const { id } = request.params as { id: string };

    const parsed = CompleteUploadBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid upload completion request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    const verification = await getVerification(deps.db, auth.organisationId, id);
    if (!verification) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No verification ${id}.`, instance: request.url });
      return;
    }

    // Resolved against the caller's organisation before it can reach the
    // outbox payload — a run id from a request body is untrusted input
    // (CLAUDE.md 19.1, 19.5).
    if (parsed.data.backtestRunId) {
      const run = await getBacktestRun(deps.db, auth.organisationId, parsed.data.backtestRunId);
      if (!run) {
        sendProblem(reply, {
          status: 404,
          title: "Not Found",
          detail: `No backtest run ${parsed.data.backtestRunId}.`,
          instance: request.url,
        });
        return;
      }
      if (run.strategyVersionId !== verification.strategyVersionId) {
        sendProblem(reply, {
          status: 422,
          title: "Run does not match verification",
          detail: "The backtest run and the verification must belong to the same strategy version.",
          instance: request.url,
        });
        return;
      }
    }

    const idem = await checkIdempotency(deps.db, idempotencyKey, parsed.data);
    if (idem.status === "CONFLICT") {
      sendProblem(reply, { status: 409, title: "Idempotency-Key conflict", detail: "Key reused with a different body.", instance: request.url });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const result = await completeReportUpload(deps.db, deps.s3, deps.bucket, {
      organisationId: verification.organisationId,
      verificationId: verification.id,
      kind: parsed.data.kind,
      objectKey: parsed.data.objectKey,
      uploadedByUserId: auth.userId,
      backtestRunId: parsed.data.backtestRunId,
    });

    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });

    reply.code(201).send(result);
  });
}
