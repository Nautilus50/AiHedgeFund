import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  benchmarkTasks,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  practiceRuns,
  prompts,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { PracticeRunJob, QUEUE_NAMES, routeOutboxEvent } from "@arf-os/event-bus";
import {
  createPracticeRun,
  listBenchmarkTasks,
  listPracticeRuns,
  reviewPracticeRun,
  submitBenchmarkTask,
} from "./practice-arena.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("practice arena (integration)", () => {
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

  async function approvedPromptId(role: string): Promise<string> {
    const [row] = await db.select().from(prompts).where(and(eq(prompts.role, role), eq(prompts.status, "APPROVED"))).limit(1);
    if (!row) throw new Error(`no APPROVED prompt seeded for ${role}`);
    return row.id;
  }

  it("creates a benchmark task for a registered role", async () => {
    const org = await seedOrganisation(db);

    const outcome = await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "IDEA_SCOUT",
      objective: "Separate a falsifiable idea from a marketing claim.",
      visibility: "VISIBLE",
      createdByUserId: org.userId,
    });

    expect(outcome).toMatchObject({ ok: true });
  });

  it("refuses a role with no agent runtime implementation, without creating anything", async () => {
    const org = await seedOrganisation(db);

    const outcome = await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "PINE_ENGINEER",
      objective: "Compile a known definition.",
      visibility: "VISIBLE",
      createdByUserId: org.userId,
    });

    expect(outcome).toEqual({ ok: false, reasonCode: "ROLE_NOT_REGISTERED" });
    const rows = await db.select().from(benchmarkTasks);
    expect(rows).toHaveLength(0);
  });

  it("never lists another organisation's benchmark tasks", async () => {
    const orgA = await seedOrganisation(db, { slug: "practice-org-a" });
    const orgB = await seedOrganisation(db, { slug: "practice-org-b" });

    await submitBenchmarkTask(db, {
      organisationId: orgB.organisationId,
      role: "IDEA_SCOUT",
      objective: "Org B's task.",
      visibility: "VISIBLE",
      createdByUserId: orgB.userId,
    });

    const result = await listBenchmarkTasks(db, orgA.organisationId, orgA.userId);
    expect(result).toHaveLength(0);
  });

  it("excludes a HIDDEN task from other users but includes it for its own creator", async () => {
    const org = await seedOrganisation(db);
    const other = await seedOrganisation(db, { slug: "practice-visibility-other" });

    await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "IDEA_SCOUT",
      objective: "A hidden task.",
      visibility: "HIDDEN",
      createdByUserId: org.userId,
    });

    const asCreator = await listBenchmarkTasks(db, org.organisationId, org.userId);
    expect(asCreator).toHaveLength(1);

    const asOther = await listBenchmarkTasks(db, org.organisationId, other.userId);
    expect(asOther).toHaveLength(0);
  });

  it("creates the practice run and a transactionally-consistent outbox event routed to the practice-run queue", async () => {
    const org = await seedOrganisation(db);
    const promptId = await approvedPromptId("IDEA_SCOUT");

    const { benchmarkTaskId } = await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "IDEA_SCOUT",
      objective: "Separate a falsifiable idea from a marketing claim.",
      visibility: "VISIBLE",
      createdByUserId: org.userId,
    }).then((o) => (o.ok ? o : Promise.reject(new Error("expected ok"))));

    const outcome = await createPracticeRun(db, {
      organisationId: org.organisationId,
      benchmarkTaskId,
      promptId,
      actor: org.userId,
    });

    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw new Error("expected ok outcome");

    const [runRow] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, outcome.practiceRunId));
    expect(runRow).toMatchObject({ benchmarkTaskId, promptId, role: "IDEA_SCOUT", status: "QUEUED" });

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "practice_run.requested"));
    if (!event) throw new Error("expected a practice_run.requested outbox event");
    expect(event.aggregateId).toBe(outcome.practiceRunId);
    expect(event.organisationId).toBe(org.organisationId);
    expect(() => PracticeRunJob.parse(event.payload)).not.toThrow();
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(QUEUE_NAMES.practiceRun);
  });

  it("refuses a prompt whose role doesn't match the benchmark task's role", async () => {
    const org = await seedOrganisation(db);
    const wrongRolePromptId = await approvedPromptId("INDICATOR_RESEARCHER");

    const outcome0 = await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "IDEA_SCOUT",
      objective: "An idea-scout task.",
      visibility: "VISIBLE",
      createdByUserId: org.userId,
    });
    if (!outcome0.ok) throw new Error("expected ok");

    const outcome = await createPracticeRun(db, {
      organisationId: org.organisationId,
      benchmarkTaskId: outcome0.benchmarkTaskId,
      promptId: wrongRolePromptId,
      actor: org.userId,
    });

    expect(outcome).toEqual({ ok: false, reasonCode: "PROMPT_ROLE_MISMATCH" });
  });

  it("never lists another organisation's practice runs", async () => {
    const orgA = await seedOrganisation(db, { slug: "practice-runs-org-a" });
    const orgB = await seedOrganisation(db, { slug: "practice-runs-org-b" });

    const outcome0 = await submitBenchmarkTask(db, {
      organisationId: orgB.organisationId,
      role: "IDEA_SCOUT",
      objective: "Org B's task.",
      visibility: "VISIBLE",
      createdByUserId: orgB.userId,
    });
    if (!outcome0.ok) throw new Error("expected ok");

    const result = await listPracticeRuns(db, orgA.organisationId, outcome0.benchmarkTaskId);
    expect(result).toBeUndefined();
  });

  it("records a human review score atomically with an audit event, and refuses to review a non-SUCCEEDED run", async () => {
    const org = await seedOrganisation(db);
    const promptId = await approvedPromptId("IDEA_SCOUT");

    const taskOutcome = await submitBenchmarkTask(db, {
      organisationId: org.organisationId,
      role: "IDEA_SCOUT",
      objective: "An idea-scout task.",
      visibility: "VISIBLE",
      createdByUserId: org.userId,
    });
    if (!taskOutcome.ok) throw new Error("expected ok");

    const runOutcome = await createPracticeRun(db, {
      organisationId: org.organisationId,
      benchmarkTaskId: taskOutcome.benchmarkTaskId,
      promptId,
      actor: org.userId,
    });
    if (!runOutcome.ok) throw new Error("expected ok");

    // Still QUEUED — the worker hasn't run it yet.
    const tooEarly = await reviewPracticeRun(db, {
      organisationId: org.organisationId,
      practiceRunId: runOutcome.practiceRunId,
      score: 0.8,
      notes: undefined,
      reviewerUserId: org.userId,
    });
    expect(tooEarly).toEqual({ ok: false, reasonCode: "PRACTICE_RUN_NOT_SUCCEEDED" });

    await db.update(practiceRuns).set({ status: "SUCCEEDED", output: { result: {} } }).where(eq(practiceRuns.id, runOutcome.practiceRunId));

    const first = await reviewPracticeRun(db, {
      organisationId: org.organisationId,
      practiceRunId: runOutcome.practiceRunId,
      score: 0.8,
      notes: "Solid falsification test.",
      reviewerUserId: org.userId,
    });
    expect(first).toEqual({ ok: true });

    const [runAfterFirst] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, runOutcome.practiceRunId));
    expect(runAfterFirst?.humanReviewScore).toBe("0.80");

    const auditRows = await db.select().from(auditEvents).where(eq(auditEvents.aggregateId, runOutcome.practiceRunId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "practice_run.reviewed",
      aggregateType: "practice_run",
      newStateSummary: { humanReviewScore: "0.80" },
    });

    // Re-review is allowed — the prior score survives in the audit trail, not overwritten silently.
    const second = await reviewPracticeRun(db, {
      organisationId: org.organisationId,
      practiceRunId: runOutcome.practiceRunId,
      score: 0.3,
      notes: "On reflection, weaker than I thought.",
      reviewerUserId: org.userId,
    });
    expect(second).toEqual({ ok: true });

    const [runAfterSecond] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, runOutcome.practiceRunId));
    expect(runAfterSecond?.humanReviewScore).toBe("0.30");

    const auditRowsAfterSecond = await db.select().from(auditEvents).where(eq(auditEvents.aggregateId, runOutcome.practiceRunId));
    expect(auditRowsAfterSecond).toHaveLength(2);
    expect(auditRowsAfterSecond[1]).toMatchObject({
      priorStateSummary: { humanReviewScore: "0.80" },
      newStateSummary: { humanReviewScore: "0.30" },
    });
  });
});
