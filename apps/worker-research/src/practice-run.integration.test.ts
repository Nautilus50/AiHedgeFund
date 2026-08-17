import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { createDevelopmentProvider } from "@arf-os/agent-runtime";
import {
  benchmarkTasks,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  practiceRuns,
  prompts,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { handlePracticeRun } from "./handlers.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("handlePracticeRun (integration)", () => {
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

  async function seedBenchmarkTask(organisationId: string, createdByUserId: string, role: string, objective: string): Promise<string> {
    const benchmarkTaskId = generateId<string>();
    await db.insert(benchmarkTasks).values({ id: benchmarkTaskId, organisationId, role, objective, createdByUserId });
    return benchmarkTaskId;
  }

  async function seedDraftPrompt(role: string): Promise<string> {
    const promptId = generateId<string>();
    await db.insert(prompts).values({
      id: promptId,
      role,
      semanticVersion: "0.1.0-challenger",
      content: "You are IDEA_SCOUT. Propose one falsifiable idea. Respond as JSON matching the schema.",
      contentHash: `hash-${promptId}`,
      status: "DRAFT",
    });
    return promptId;
  }

  async function seedPracticeRun(organisationId: string, benchmarkTaskId: string, promptId: string, role: string): Promise<string> {
    const practiceRunId = generateId<string>();
    await db.insert(practiceRuns).values({ id: practiceRunId, organisationId, benchmarkTaskId, promptId, role, status: "QUEUED" });
    return practiceRunId;
  }

  it("runs a practice task against a DRAFT prompt, not just the currently-APPROVED one", async () => {
    const org = await seedOrganisation(db);
    const draftPromptId = await seedDraftPrompt("IDEA_SCOUT");
    const benchmarkTaskId = await seedBenchmarkTask(org.organisationId, org.userId, "IDEA_SCOUT", "Find a testable edge.");
    const practiceRunId = await seedPracticeRun(org.organisationId, benchmarkTaskId, draftPromptId, "IDEA_SCOUT");

    const result = await handlePracticeRun(db, createDevelopmentProvider(), {
      practiceRunId,
      benchmarkTaskId,
      promptId: draftPromptId,
      role: "IDEA_SCOUT",
    });

    expect(result).toEqual({ ok: true });

    const [run] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, practiceRunId));
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.schemaValid).toBe(true);
    expect(run?.completedAt).not.toBeNull();

    const output = run?.output as { result?: { title?: string }; promptVersion?: string } | null;
    expect(output?.result?.title).toBeTruthy();
    expect(output?.promptVersion).toBe("0.1.0-challenger");
  });

  it("never persists the raw provider output anywhere — practice content isn't protected research evidence, but it also isn't logged/stored raw", async () => {
    const org = await seedOrganisation(db);
    const [approved] = await db.select().from(prompts).where(and(eq(prompts.role, "IDEA_SCOUT"), eq(prompts.status, "APPROVED")));
    if (!approved) throw new Error("expected a seeded APPROVED prompt");
    const benchmarkTaskId = await seedBenchmarkTask(org.organisationId, org.userId, "IDEA_SCOUT", "Find a testable edge.");
    const practiceRunId = await seedPracticeRun(org.organisationId, benchmarkTaskId, approved.id, "IDEA_SCOUT");

    await handlePracticeRun(db, createDevelopmentProvider(), {
      practiceRunId,
      benchmarkTaskId,
      promptId: approved.id,
      role: "IDEA_SCOUT",
    });

    const [run] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, practiceRunId));
    const serialized = JSON.stringify(run?.output);
    expect(serialized).not.toContain("rawOutput");
  });

  it("is idempotent — replaying an already-SUCCEEDED run's job skips it", async () => {
    const org = await seedOrganisation(db);
    const [approved] = await db.select().from(prompts).where(and(eq(prompts.role, "IDEA_SCOUT"), eq(prompts.status, "APPROVED")));
    if (!approved) throw new Error("expected a seeded APPROVED prompt");
    const benchmarkTaskId = await seedBenchmarkTask(org.organisationId, org.userId, "IDEA_SCOUT", "Find a testable edge.");
    const practiceRunId = await seedPracticeRun(org.organisationId, benchmarkTaskId, approved.id, "IDEA_SCOUT");
    const provider = createDevelopmentProvider();
    const job = { practiceRunId, benchmarkTaskId, promptId: approved.id, role: "IDEA_SCOUT" as const };

    const first = await handlePracticeRun(db, provider, job);
    expect(first).toEqual({ ok: true });

    const second = await handlePracticeRun(db, provider, job);
    expect(second).toEqual({ ok: true, skipped: true });
  });

  it("refuses a role with no registered agent runtime implementation", async () => {
    const org = await seedOrganisation(db);
    const promptId = generateId<string>();
    await db.insert(prompts).values({
      id: promptId,
      role: "PINE_ENGINEER",
      semanticVersion: "0.1.0",
      content: "irrelevant",
      contentHash: "irrelevant",
      status: "DRAFT",
    });
    const benchmarkTaskId = await seedBenchmarkTask(org.organisationId, org.userId, "PINE_ENGINEER", "Compile a known definition.");
    const practiceRunId = await seedPracticeRun(org.organisationId, benchmarkTaskId, promptId, "PINE_ENGINEER");

    await expect(
      handlePracticeRun(db, createDevelopmentProvider(), { practiceRunId, benchmarkTaskId, promptId, role: "PINE_ENGINEER" }),
    ).rejects.toThrow(/not wired/);
  });
});
