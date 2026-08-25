import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import type { BillingProvider } from "../services/storefront/billing-provider.js";
import { handleBillingWebhook } from "../services/storefront/webhooks.js";

export interface BillingWebhookPluginOptions {
  db: Database;
  billing: BillingProvider;
}

/**
 * Processor webhook endpoint (ADR 0015). An encapsulated plugin so its raw-body
 * parser — required because the signature covers the exact bytes the processor
 * sent, not a re-serialised object — never changes body parsing for any other
 * route.
 */
export async function registerBillingWebhook(
  app: FastifyInstance,
  options: BillingWebhookPluginOptions,
): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/v1/webhooks/billing", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["stripe-signature"];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    const outcome = await handleBillingWebhook(
      { db: options.db, provider: options.billing, traceId: request.id },
      rawBody,
      signatureHeader,
    );

    switch (outcome.outcome) {
      case "REJECTED":
        // No detail about why beyond the code: an attacker probing signatures
        // learns nothing from the response.
        sendProblem(reply, {
          status: 401,
          title: "Invalid signature",
          detail: "Webhook signature verification failed.",
          instance: request.url,
          code: outcome.reasonCode,
        });
        return;
      case "FAILED":
        // 500 so the processor retries; the event is already recorded as
        // FAILED, and its unique id keeps the retry from double-applying.
        request.log.error(
          { providerEventId: outcome.providerEventId, eventType: outcome.eventType, reasonCode: outcome.reasonCode },
          "Billing webhook processing failed",
        );
        sendProblem(reply, {
          status: 500,
          title: "Webhook processing failed",
          detail: "The event was recorded but could not be applied.",
          instance: request.url,
          code: outcome.reasonCode,
        });
        return;
      default:
        reply.code(200).send({ outcome: outcome.outcome });
    }
  });
}
