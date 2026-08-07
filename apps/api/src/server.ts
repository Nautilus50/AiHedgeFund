import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createDatabase } from "@arf-os/db";
import { registerAuth } from "./plugins/auth.js";

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
