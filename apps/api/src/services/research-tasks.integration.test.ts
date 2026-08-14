import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  prompts,
  researchTasks,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { AgentRunJob, routeOutboxEvent, QUEUE_NAMES } from "@arf-os/event-bus";
import { listResearchTasks, submitResearchTask } from "./research-tasks.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("research tasks (integration)", () => {
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

  it("an APPROVED prompt exists for both registered roles (real migration seed data, or truncateAll's re-seed in a test)", async () => {
    const rows = await db.select().from(prompts).where(eq(prompts.status, "APPROVED"));
    const roles = rows.map((r) => r.role).sort();
    expect(roles).toEqual(["IDEA_SCOUT", "INDICATOR_RESEARCHER"]);
  });

  it("creates the research task and a transactionally-consistent outbox event routed to the agent-run queue", async () => {
    const org = await seedOrganisation(db);

    const outcome = await submitResearchTask(db, {
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      role: "IDEA_SCOUT",
      objective: "Find a testable edge in BTC perpetuals.",
      actor: org.userId,
    });

    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw new Error("expected ok outcome");

    const [taskRow] = await db.select().from(researchTasks).where(eq(researchTasks.id, outcome.researchTaskId));
    expect(taskRow).toMatchObject({
      campaignId: org.campaignId,
      role: "IDEA_SCOUT",
      status: "QUEUED",
      input: { objective: "Find a testable edge in BTC perpetuals." },
    });

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "agent_run.requested"));
    if (!event) throw new Error("expected an agent_run.requested outbox event");
    expect(event.aggregateId).toBe(outcome.researchTaskId);
    expect(event.organisationId).toBe(org.organisationId);
    expect(() => AgentRunJob.parse(event.payload)).not.toThrow();
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      QUEUE_NAMES.agentRun,
    );
  });

  it("refuses a role with no agent runtime implementation, without creating anything", async () => {
    const org = await seedOrganisation(db);

    const outcome = await submitResearchTask(db, {
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      role: "PINE_ENGINEER",
      objective: "Write the Pine source.",
      actor: org.userId,
    });

    expect(outcome).toEqual({ ok: false, reasonCode: "ROLE_NOT_REGISTERED" });
    const rows = await db.select().from(researchTasks);
    expect(rows).toHaveLength(0);
  });

  it("refuses a campaign that doesn't belong to the caller's organisation", async () => {
    const orgA = await seedOrganisation(db, { slug: "research-task-org-a" });
    const orgB = await seedOrganisation(db, { slug: "research-task-org-b" });

    const outcome = await submitResearchTask(db, {
      organisationId: orgA.organisationId,
      campaignId: orgB.campaignId,
      role: "IDEA_SCOUT",
      objective: "Find a testable edge.",
      actor: orgA.userId,
    });

    expect(outcome).toEqual({ ok: false, reasonCode: "CAMPAIGN_NOT_FOUND" });
  });

  it("never lists another organisation's research tasks", async () => {
    const orgA = await seedOrganisation(db, { slug: "research-list-org-a" });
    const orgB = await seedOrganisation(db, { slug: "research-list-org-b" });

    await submitResearchTask(db, {
      organisationId: orgB.organisationId,
      campaignId: orgB.campaignId,
      role: "IDEA_SCOUT",
      objective: "Org B's idea.",
      actor: orgB.userId,
    });

    const result = await listResearchTasks(db, orgA.organisationId, orgB.campaignId);
    expect(result).toBeUndefined();
  });
});
