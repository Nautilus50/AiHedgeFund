import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";

const PORT = Number(process.env.PORT ?? 4000);

async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  app.get("/health", async () => ({
    status: "ok",
    service: "arf-os-api",
    timestamp: new Date().toISOString(),
  }));

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
