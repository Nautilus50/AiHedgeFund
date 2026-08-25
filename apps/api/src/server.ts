import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { createDatabase } from "@arf-os/db";
import { redactSseTicket, redactWebhookToken } from "./lib/log-redaction.js";
import { buildProblemDetails } from "./lib/problem-details.js";
import { registerAuth } from "./plugins/auth.js";
import { registerClerkWebhook } from "./plugins/webhooks-clerk.js";
import { SseHub } from "./lib/sse-hub.js";
import { createObjectStoreClient } from "./services/object-store.js";
import { registerRoutes } from "./routes/index.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file present — expected in production, where env vars are injected directly.
}

const PORT = Number(process.env.PORT ?? 4000);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function buildServer() {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactSseTicket(redactWebhookToken(request.url)),
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort ?? 0,
          };
        },
      },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  const db = createDatabase(requireEnv("DATABASE_URL"));
  await registerAuth(app, { db, clerkSecretKey: requireEnv("CLERK_SECRET_KEY") });

  // CLERK_WEBHOOK_SIGNING_SECRET is intentionally not requireEnv()'d — unlike
  // every other secret above, local dev boots fine without ever configuring
  // Clerk's webhook dashboard; the route just 404s until it's set (ADR 0013).
  await app.register(registerClerkWebhook, { db, signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET });

  // Registered after auth, so its onRequest hook runs second and can key on
  // request.auth.organisationId — every caller inside one org shares a
  // budget, rather than each caller behind a shared NAT tripping the limit
  // for everyone else (CLAUDE.md 19: rate limit public endpoints). Anonymous
  // requests (no resolved auth) fall back to IP.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.auth?.organisationId ?? request.ip,
    errorResponseBuilder: (request, context) =>
      buildProblemDetails({
        status: 429,
        title: "Too Many Requests",
        detail: `Rate limit exceeded, retry in ${context.after}.`,
        instance: request.url,
        code: "RATE_LIMITED",
      }),
  });

  const bucket = requireEnv("OBJECT_STORE_BUCKET");
  const s3 = createObjectStoreClient({
    endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
    bucket,
    accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    region: process.env.OBJECT_STORE_REGION,
  });

  // One shared poller per process, not one per open SSE connection — the
  // Postgres pool is capped at 10 and shared with every ordinary request
  // (ADR 0007).
  const sseHub = new SseHub(db);
  await sseHub.start();
  app.addHook("onClose", () => {
    sseHub.stop();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.name === "UnauthorizedError") {
      reply.code(401).send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: error.message,
        instance: request.url,
      });
      return;
    }
    // A plugin's errorResponseBuilder (e.g. rate-limit above) that throws an
    // already-shaped ProblemDetails object carries its own HTTP status in
    // `.status`. A thrown plain object has no `.statusCode` for Fastify's
    // own error machinery to pick up, so without applying it explicitly here
    // the correct JSON body would ship under an incorrect default 200.
    const problem = error as unknown as { status?: unknown };
    if (typeof problem.status === "number") {
      reply.code(problem.status).type("application/problem+json").send(error);
      return;
    }
    reply.send(error);
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "arf-os-api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/v1/me", async (request) => {
    const auth = request.requireAuth();
    return { userId: auth.userId, organisationId: auth.organisationId, role: auth.role };
  });

  registerRoutes(app, { db, s3, bucket, sseHub });

  return app;
}

async function main() {
  const app = await buildServer();
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
