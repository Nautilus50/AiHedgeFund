import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, closeDatabase, createTestDatabase, isTestDatabaseAvailable, memberships, organisations, truncateAll, users, type Database } from "@arf-os/db";
import type { OrganizationMembershipJSON } from "@arf-os/auth";
import { provisionFromMembershipEvent } from "./provisioning.js";

const available = await isTestDatabaseAvailable();

/**
 * Only the fields `provisionFromMembershipEvent` actually reads are given
 * real values — `OrganizationMembershipJSON` has many more fields than that
 * (metadata, permissions, timestamps) that this service never touches.
 */
function membershipEvent(overrides: {
  organizationId: string;
  organizationName?: string;
  organizationSlug?: string;
  userId: string;
  identifier?: string;
  role?: string;
}): OrganizationMembershipJSON {
  return {
    object: "organization_membership",
    id: `orgmem_${overrides.userId}`,
    role: overrides.role ?? "org:member",
    organization: {
      object: "organization",
      id: overrides.organizationId,
      name: overrides.organizationName ?? "Test Org",
      slug: overrides.organizationSlug ?? `test-org-${overrides.organizationId}`,
    },
    public_user_data: {
      identifier: overrides.identifier ?? `${overrides.userId}@example.com`,
      first_name: "Ada",
      last_name: "Lovelace",
      user_id: overrides.userId,
    },
  } as unknown as OrganizationMembershipJSON;
}

describe.skipIf(!available)("provisioning (integration)", () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("provisions a brand-new org/user/membership, forcing ADMIN for the org's first member regardless of the Clerk role slug", async () => {
    const event = membershipEvent({ organizationId: "org_new_1", userId: "user_new_1", role: "org:member" });

    const result = await provisionFromMembershipEvent(db, event);
    expect(result.membershipCreated).toBe(true);

    const [org] = await db.select().from(organisations).where(eq(organisations.id, result.organisationId));
    expect(org?.clerkOrganisationId).toBe("org_new_1");
    expect(org?.name).toBe("Test Org");

    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user?.externalAuthSubject).toBe("user_new_1");
    expect(user?.email).toBe("user_new_1@example.com");

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, result.userId));
    expect(membership?.role).toBe("ADMIN");
    expect(membership).toBeDefined();

    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.aggregateId, membership?.id ?? ""));
    expect(audit).toMatchObject({ actor: "clerk:webhook", action: "PROVISIONED", aggregateType: "membership" });
  });

  it("is idempotent — replaying the identical event creates no duplicate rows", async () => {
    const event = membershipEvent({ organizationId: "org_replay", userId: "user_replay" });

    const first = await provisionFromMembershipEvent(db, event);
    const second = await provisionFromMembershipEvent(db, event);

    expect(first.membershipCreated).toBe(true);
    expect(second.membershipCreated).toBe(false);
    expect(second.organisationId).toBe(first.organisationId);
    expect(second.userId).toBe(first.userId);

    expect(await db.select().from(organisations)).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("maps a second member's own Clerk role instead of forcing ADMIN, since the org already exists", async () => {
    const founder = membershipEvent({ organizationId: "org_second_member", userId: "user_founder", role: "org:admin" });
    await provisionFromMembershipEvent(db, founder);

    const secondMember = membershipEvent({ organizationId: "org_second_member", userId: "user_second", role: "org:member" });
    const result = await provisionFromMembershipEvent(db, secondMember);

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, result.userId));
    expect(membership?.role).toBe("RESEARCHER");

    const [org] = await db.select().from(organisations).where(eq(organisations.clerkOrganisationId, "org_second_member"));
    expect(org).toBeDefined();
    expect(await db.select().from(memberships).where(eq(memberships.organisationId, org?.id ?? ""))).toHaveLength(2);
  });

  it("maps an explicit org:admin role to ADMIN for a non-founding member too", async () => {
    const founder = membershipEvent({ organizationId: "org_two_admins", userId: "user_founder_2", role: "org:admin" });
    await provisionFromMembershipEvent(db, founder);

    const secondAdmin = membershipEvent({ organizationId: "org_two_admins", userId: "user_second_admin", role: "org:admin" });
    const result = await provisionFromMembershipEvent(db, secondAdmin);

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, result.userId));
    expect(membership?.role).toBe("ADMIN");
  });

  it("reuses an already-linked organisation rather than creating a second one for the same Clerk org id", async () => {
    const first = await provisionFromMembershipEvent(db, membershipEvent({ organizationId: "org_shared", userId: "user_a" }));
    const second = await provisionFromMembershipEvent(db, membershipEvent({ organizationId: "org_shared", userId: "user_b" }));

    expect(second.organisationId).toBe(first.organisationId);
    expect(await db.select().from(organisations)).toHaveLength(1);
  });

  it("reuses an already-linked user rather than creating a second one for the same Clerk user id, even across organisations", async () => {
    const first = await provisionFromMembershipEvent(db, membershipEvent({ organizationId: "org_x", userId: "user_shared" }));
    const second = await provisionFromMembershipEvent(db, membershipEvent({ organizationId: "org_y", userId: "user_shared" }));

    expect(second.userId).toBe(first.userId);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(2);
  });
});
