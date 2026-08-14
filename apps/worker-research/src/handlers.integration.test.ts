import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { createDevelopmentProvider } from "@arf-os/agent-runtime";
import {
  agentRunDiagnostics,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  prompts,
  researchTasks,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { handleAgentRun } from "./handlers.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("handleAgentRun (integration)", () => {
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

  async function seedResearchTask(campaignId: string, role: string, objective: string): Promise<string> {
    const researchTaskId = generateId<string>();
    await db.insert(researchTasks).values({
      id: researchTaskId,
      campaignId,
      role,
      status: "QUEUED",
      input: { objective },
    });
    return researchTaskId;
  }

  it("runs IDEA_SCOUT end to end: SUCCEEDED status, safe summary in output, raw output in diagnostics", async () => {
    const org = await seedOrganisation(db);
    const researchTaskId = await seedResearchTask(org.campaignId, "IDEA_SCOUT", "Find a testable edge.");

    const result = await handleAgentRun(db, createDevelopmentProvider(), {
      campaignId: org.campaignId,
      researchTaskId,
      role: "IDEA_SCOUT",
    });

    expect(result).toEqual({ ok: true });

    const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, researchTaskId));
    expect(task?.status).toBe("SUCCEEDED");
    expect(task?.completedAt).not.toBeNull();
    const output = task?.output as { result?: { title?: string } } | null;
    expect(output?.result?.title).toBeTruthy();

    const [diagnostics] = await db
      .select()
      .from(agentRunDiagnostics)
      .where(eq(agentRunDiagnostics.researchTaskId, researchTaskId));
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.rawProviderOutput).toBeTruthy();
  });

  it("runs INDICATOR_RESEARCHER end to end too — the generalized dispatch isn't hardcoded to IDEA_SCOUT", async () => {
    const org = await seedOrganisation(db);
    const researchTaskId = await seedResearchTask(org.campaignId, "INDICATOR_RESEARCHER", "Research the funding-rate indicator.");

    const result = await handleAgentRun(db, createDevelopmentProvider(), {
      campaignId: org.campaignId,
      researchTaskId,
      role: "INDICATOR_RESEARCHER",
    });

    expect(result).toEqual({ ok: true });
    const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, researchTaskId));
    expect(task?.status).toBe("SUCCEEDED");
    const output = task?.output as { result?: { indicatorName?: string } } | null;
    expect(output?.result?.indicatorName).toBeTruthy();
  });

  it("is idempotent — replaying an already-SUCCEEDED task's job skips it, without a second diagnostics row", async () => {
    const org = await seedOrganisation(db);
    const researchTaskId = await seedResearchTask(org.campaignId, "IDEA_SCOUT", "Find a testable edge.");
    const provider = createDevelopmentProvider();
    const job = { campaignId: org.campaignId, researchTaskId, role: "IDEA_SCOUT" as const };

    const first = await handleAgentRun(db, provider, job);
    expect(first).toEqual({ ok: true });

    const second = await handleAgentRun(db, provider, job);
    expect(second).toEqual({ ok: true, skipped: true });

    const diagnosticsRows = await db
      .select()
      .from(agentRunDiagnostics)
      .where(eq(agentRunDiagnostics.researchTaskId, researchTaskId));
    expect(diagnosticsRows).toHaveLength(1);
  });

  it("refuses a role with no registered agent runtime implementation", async () => {
    const org = await seedOrganisation(db);
    const researchTaskId = await seedResearchTask(org.campaignId, "PINE_ENGINEER", "Write the Pine source.");

    await expect(
      handleAgentRun(db, createDevelopmentProvider(), {
        campaignId: org.campaignId,
        researchTaskId,
        role: "PINE_ENGINEER",
      }),
    ).rejects.toThrow(/not wired/);
  });

  it("hard-fails rather than falling back when no APPROVED prompt exists for the role (CLAUDE.md 11.2)", async () => {
    const org = await seedOrganisation(db);
    const researchTaskId = await seedResearchTask(org.campaignId, "IDEA_SCOUT", "Find a testable edge.");

    await db.delete(prompts).where(and(eq(prompts.role, "IDEA_SCOUT"), eq(prompts.status, "APPROVED")));

    await expect(
      handleAgentRun(db, createDevelopmentProvider(), {
        campaignId: org.campaignId,
        researchTaskId,
        role: "IDEA_SCOUT",
      }),
    ).rejects.toThrow(/No APPROVED prompt/);
  });
});
