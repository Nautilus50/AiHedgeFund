import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createDatabase } from "@arf-os/db";
import { createWorkflowService, DrizzleWorkflowRepository } from "@arf-os/workflow";
import { registerAuth } from "./plugins/auth.js";
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
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  const db = createDatabase(requireEnv("DATABASE_URL"));
  await registerAuth(app, { db, clerkSecretKey: requireEnv("CLERK_SECRET_KEY") });

  const bucket = requireEnv("OBJECT_STORE_BUCKET");
  const s3 = createObjectStoreClient({
    endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
    bucket,
    accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    region: process.env.OBJECT_STORE_REGION,
  });
  const workflow = createWorkflowService(new DrizzleWorkflowRepository(db));

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

  registerRoutes(app, { db, s3, bucket, workflow });

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
