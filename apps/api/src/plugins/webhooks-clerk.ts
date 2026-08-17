import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { verifyClerkWebhook, type OrganizationMembershipJSON } from "@arf-os/auth";
import { sendProblem } from "../lib/problem-details.js";
import { provisionFromMembershipEvent } from "../services/provisioning.js";

export interface ClerkWebhookPluginOptions {
  db: Database;
  /** From `CLERK_WEBHOOK_SIGNING_SECRET` — undefined until the Clerk dashboard's webhook endpoint is configured. */
  signingSecret: string | undefined;
}

function nodeHeadersToFetchHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

/**
 * Auto-provisions `organisations`/`users`/`memberships` rows from Clerk's
 * `organizationMembership.created` webhook (ADR 0013) — replaces the manual
 * SQL step in docs/local-setup.md. An encapsulated plugin (own Fastify
 * scope) so its raw-body content-type parser override — required for
 * `svix`'s signature to verify against the exact bytes Clerk signed — never
 * changes body parsing for any other route.
 */
export async function registerClerkWebhook(app: FastifyInstance, options: ClerkWebhookPluginOptions): Promise<void> {
  if (!options.signingSecret) {
    // No boot-time throw: local dev boots fine without ever touching
    // Clerk's webhook dashboard config, same as it always has. The route
    // exists but always 404s until the secret is configured, rather than
    // silently accepting unverifiable requests.
    app.post("/v1/webhooks/clerk", async (request, reply) => {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "Clerk webhook is not configured.", instance: request.url });
    });
    return;
  }
  const signingSecret = options.signingSecret;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/v1/webhooks/clerk", async (request, reply) => {
    const rawBody = request.body as Buffer;
    const url = new URL(request.url, `http://${request.hostname}`);
    const fetchRequest = new Request(url, {
      method: "POST",
      headers: nodeHeadersToFetchHeaders(request.headers),
      body: rawBody,
    });

    const event = await verifyClerkWebhook(fetchRequest, signingSecret);
    if (!event) {
      sendProblem(reply, { status: 401, title: "Invalid signature", detail: "Webhook signature verification failed.", instance: request.url });
      return;
    }

    if (event.type !== "organizationMembership.created") {
      // Acknowledged so Clerk doesn't retry forever, but not acted on —
      // organization.created/user.created carry nothing this route needs
      // that the membership event doesn't already embed (ADR 0013).
      reply.code(200).send({ ok: true, handled: false });
      return;
    }

    const result = await provisionFromMembershipEvent(options.db, event.data as OrganizationMembershipJSON);
    reply.code(200).send({ ok: true, handled: true, ...result });
  });
}
