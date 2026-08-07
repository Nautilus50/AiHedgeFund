import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations } from "./identity.js";

/**
 * Generic pointer to a large immutable object in S3-compatible storage
 * (spec 14.6/14.7). PostgreSQL stores identity/checksum; the object store
 * holds the bytes.
 */
export const artefacts = pgTable("artefacts", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  kind: text("kind").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
