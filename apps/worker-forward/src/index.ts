import Fastify from "fastify";

const PORT = Number(process.env.PORT ?? 4004);

async function main() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "arf-os-worker-forward",
    timestamp: new Date().toISOString(),
  }));

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
