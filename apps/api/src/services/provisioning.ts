import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { auditEvents, memberships, organisations, users } from "@arf-os/db";
import type { OrganizationMembershipJSON } from "@arf-os/auth";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export interface ProvisioningResult {
  organisationId: string;
  userId: string;
  membershipCreated: boolean;
}

/**
 * Provisions (or no-ops on an already-provisioned) organisation/user/
 * membership from a single `organizationMembership.created` Clerk webhook
 * event — chosen over reacting to `organization.created`/`user.created`
 * separately because Clerk's delivery order across the three events for one
 * signup isn't guaranteed, while this one event embeds everything needed
 * (`event.organization`, `event.public_user_data`) to provision all three
 * rows without depending on that order (ADR 0013).
 *
 * Check-then-insert, this repo's established idempotency convention — plus
 * a unique-violation catch as a race backstop, since this route is
 * internet-facing and at-least-once (unlike every other check-then-insert
 * caller in this repo, which is operator- or event-bus-triggered only). A
 * duplicate membership would be a security-relevant outcome (double
 * granting), not just a data-hygiene one.
 */
export async function provisionFromMembershipEvent(db: Database, event: OrganizationMembershipJSON): Promise<ProvisioningResult> {
  return db.transaction(async (tx) => {
    const [existingOrg] = await tx
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.clerkOrganisationId, event.organization.id))
      .limit(1);

    let organisationId = existingOrg?.id;
    let organisationJustCreated = false;
    if (!organisationId) {
      organisationId = generateId<string>();
      try {
        await tx.insert(organisations).values({
          id: organisationId,
          name: event.organization.name,
          slug: event.organization.slug,
          clerkOrganisationId: event.organization.id,
        });
        organisationJustCreated = true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost a race with another delivery of the same event, or a slug
        // collision with an unrelated Clerk org — re-read rather than guess which.
        const [raced] = await tx
          .select({ id: organisations.id })
          .from(organisations)
          .where(eq(organisations.clerkOrganisationId, event.organization.id))
          .limit(1);
        if (!raced) throw error;
        organisationId = raced.id;
      }
    }

    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalAuthSubject, event.public_user_data.user_id))
      .limit(1);

    let userId = existingUser?.id;
    if (!userId) {
      userId = generateId<string>();
      try {
        await tx.insert(users).values({
          id: userId,
          externalAuthSubject: event.public_user_data.user_id,
          email: event.public_user_data.identifier,
          displayName: [event.public_user_data.first_name, event.public_user_data.last_name].filter(Boolean).join(" ") || null,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const [raced] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.externalAuthSubject, event.public_user_data.user_id))
          .limit(1);
        if (!raced) throw error;
        userId = raced.id;
      }
    }

    const [existingMembership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)))
      .limit(1);

    let membershipCreated = false;
    if (!existingMembership) {
      // The org creator's own first membership always gets ADMIN, regardless
      // of Clerk's own role slug on the event — otherwise a solo signup can
      // land with no ADMIN in the org at all, recreating the exact problem
      // this feature exists to remove the manual SQL fix for.
      const role = organisationJustCreated ? "ADMIN" : event.role === "org:admin" ? "ADMIN" : "RESEARCHER";
      const membershipId = generateId<string>();
      try {
        await tx.insert(memberships).values({ id: membershipId, organisationId, userId, role });
        membershipCreated = true;
        await tx.insert(auditEvents).values({
          id: generateId<string>(),
          organisationId,
          actor: "clerk:webhook",
          action: "PROVISIONED",
          aggregateType: "membership",
          aggregateId: membershipId,
          newStateSummary: { userId, role },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent redelivery already created it — fine, this call is a no-op.
      }
    }

    return { organisationId, userId, membershipCreated };
  });
}
