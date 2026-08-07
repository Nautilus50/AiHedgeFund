import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const organisationRoleEnum = pgEnum("organisation_role", [
  "VIEWER",
  "RESEARCHER",
  "DEVELOPER",
  "VALIDATOR",
  "OPERATOR",
  "COMMITTEE_MEMBER",
  "ADMIN",
  "SERVICE_ACCOUNT",
]);

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Clerk Organization id (org_...). Nullable: an organisation can exist before it's linked to Clerk. */
  clerkOrganisationId: text("clerk_organisation_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** External auth subjects (Clerk). id is the ARF-OS user id, not the Clerk id. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  externalAuthSubject: text("external_auth_subject").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Organisation-scoped role assignment. Every aggregate access must verify membership (CLAUDE.md 19.1). */
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: organisationRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
