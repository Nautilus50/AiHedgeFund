import { createDatabase } from "./client.js";
import { organisations, users, memberships } from "./schema/index.js";
import { generateId } from "@arf-os/contracts";

/**
 * Development-only seed data. Never run against production
 * (spec 20.2 — never use production holdout data in preview environments,
 * and by the same logic never let dev fixtures reach production).
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed the database");
  }

  const db = createDatabase(connectionString);

  const organisationId = generateId<string>();
  const userId = generateId<string>();

  await db.insert(organisations).values({
    id: organisationId,
    name: "ARF-OS Dev Org",
    slug: "arf-os-dev",
  });

  await db.insert(users).values({
    id: userId,
    externalAuthSubject: "dev-fixture-user",
    email: "dev@arf-os.local",
    displayName: "Dev Researcher",
  });

  await db.insert(memberships).values({
    id: generateId<string>(),
    organisationId,
    userId,
    role: "ADMIN",
  });

  console.log(`Seeded organisation ${organisationId} with admin user ${userId}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
