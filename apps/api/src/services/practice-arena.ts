import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import { isRegisteredAgentRole, type RegisteredAgentRole } from "@arf-os/agent-runtime";
import type { Database } from "@arf-os/db";
import { auditEvents, benchmarkTasks, outboxEvents, practiceRuns, prompts } from "@arf-os/db";

export interface CreateBenchmarkTaskInput {
  organisationId: string;
  role: RegisteredAgentRole;
  objective: string;
  visibility: "VISIBLE" | "HIDDEN";
  createdByUserId: string;
}

export async function createBenchmarkTask(db: Database, input: CreateBenchmarkTaskInput): Promise<{ benchmarkTaskId: string }> {
  const benchmarkTaskId = generateId<string>();

  await db.insert(benchmarkTasks).values({
    id: benchmarkTaskId,
    organisationId: input.organisationId,
    role: input.role,
    objective: input.objective,
    visibility: input.visibility,
    createdByUserId: input.createdByUserId,
  });

  return { benchmarkTaskId };
}

export interface SubmitBenchmarkTaskInput {
  organisationId: string;
  role: string;
  objective: string;
  visibility: "VISIBLE" | "HIDDEN";
  createdByUserId: string;
}

export type SubmitBenchmarkTaskOutcome = { ok: true; benchmarkTaskId: string } | { ok: false; reasonCode: "ROLE_NOT_REGISTERED" };

/** Validates the role against only what this runtime can actually run (ADR 0008/0010), before creating anything. */
export async function submitBenchmarkTask(db: Database, input: SubmitBenchmarkTaskInput): Promise<SubmitBenchmarkTaskOutcome> {
  if (!isRegisteredAgentRole(input.role)) {
    return { ok: false, reasonCode: "ROLE_NOT_REGISTERED" };
  }

  const { benchmarkTaskId } = await createBenchmarkTask(db, {
    organisationId: input.organisationId,
    role: input.role,
    objective: input.objective,
    visibility: input.visibility,
    createdByUserId: input.createdByUserId,
  });

  return { ok: true, benchmarkTaskId };
}

/** Org-scoped list, newest first. `HIDDEN` tasks are excluded unless the caller created them — the one enforcement point for that flag this slice (ADR 0010). */
export async function listBenchmarkTasks(db: Database, organisationId: string, callerUserId: string) {
  const rows = await db.select().from(benchmarkTasks).where(eq(benchmarkTasks.organisationId, organisationId)).orderBy(benchmarkTasks.createdAt);

  return rows.filter((row) => row.visibility === "VISIBLE" || row.createdByUserId === callerUserId);
}

export async function benchmarkTaskBelongsToOrg(db: Database, organisationId: string, benchmarkTaskId: string) {
  const [row] = await db
    .select()
    .from(benchmarkTasks)
    .where(and(eq(benchmarkTasks.id, benchmarkTaskId), eq(benchmarkTasks.organisationId, organisationId)))
    .limit(1);
  return row;
}

export interface CreatePracticeRunInput {
  organisationId: string;
  benchmarkTaskId: string;
  promptId: string;
  actor: string;
}

export type CreatePracticeRunOutcome =
  | { ok: true; practiceRunId: string }
  | { ok: false; reasonCode: "BENCHMARK_TASK_NOT_FOUND" }
  | { ok: false; reasonCode: "PROMPT_NOT_FOUND" }
  | { ok: false; reasonCode: "PROMPT_ROLE_MISMATCH" };

/**
 * Creates the practice run and emits the job that runs it, in one
 * transaction (CLAUDE.md 9.3), mirroring `createResearchTask`'s exact
 * pattern. `practice_run.requested`'s payload is `PracticeRunJob`'s exact
 * shape — `routeOutboxEvent` passes it straight through with no transform.
 */
export async function createPracticeRun(db: Database, input: CreatePracticeRunInput): Promise<CreatePracticeRunOutcome> {
  const task = await benchmarkTaskBelongsToOrg(db, input.organisationId, input.benchmarkTaskId);
  if (!task) return { ok: false, reasonCode: "BENCHMARK_TASK_NOT_FOUND" };

  const [promptRow] = await db.select().from(prompts).where(eq(prompts.id, input.promptId)).limit(1);
  if (!promptRow) return { ok: false, reasonCode: "PROMPT_NOT_FOUND" };
  if (promptRow.role !== task.role) return { ok: false, reasonCode: "PROMPT_ROLE_MISMATCH" };

  const practiceRunId = generateId<string>();

  await db.transaction(async (tx) => {
    await tx.insert(practiceRuns).values({
      id: practiceRunId,
      organisationId: input.organisationId,
      benchmarkTaskId: input.benchmarkTaskId,
      promptId: input.promptId,
      role: task.role,
      status: "QUEUED",
    });

    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "practice_run.requested",
      eventVersion: "1.0.0",
      aggregateId: practiceRunId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      organisationId: input.organisationId,
      actor: input.actor,
      // PracticeRunJob's exact shape.
      payload: { practiceRunId, benchmarkTaskId: input.benchmarkTaskId, promptId: input.promptId, role: task.role },
      createdAt: now,
    });
  });

  return { ok: true, practiceRunId };
}

/** Org-scoped list for one benchmark task, newest first. */
export async function listPracticeRuns(db: Database, organisationId: string, benchmarkTaskId: string) {
  const task = await benchmarkTaskBelongsToOrg(db, organisationId, benchmarkTaskId);
  if (!task) return undefined;

  return db.select().from(practiceRuns).where(eq(practiceRuns.benchmarkTaskId, benchmarkTaskId)).orderBy(practiceRuns.createdAt);
}

export interface ReviewPracticeRunInput {
  organisationId: string;
  practiceRunId: string;
  score: number;
  notes: string | undefined;
  reviewerUserId: string;
}

export type ReviewPracticeRunOutcome =
  | { ok: true }
  | { ok: false; reasonCode: "PRACTICE_RUN_NOT_FOUND" }
  | { ok: false; reasonCode: "PRACTICE_RUN_NOT_SUCCEEDED" };

/**
 * Records a human review score, atomically with an audit record (CLAUDE.md
 * 3.4/9.4 — "human override must be explicit and audited"), mirroring
 * `recordCommitteeDecision`'s fix earlier this session: a state change and
 * its audit record used to be able to land in separate transactions here
 * too, until that was caught and fixed for committee decisions. Re-review
 * is allowed, not rejected — the audit trail preserves the prior score
 * rather than requiring a separate versioned-review-history table.
 */
export async function reviewPracticeRun(db: Database, input: ReviewPracticeRunInput): Promise<ReviewPracticeRunOutcome> {
  const [run] = await db
    .select()
    .from(practiceRuns)
    .where(and(eq(practiceRuns.id, input.practiceRunId), eq(practiceRuns.organisationId, input.organisationId)))
    .limit(1);

  if (!run) return { ok: false, reasonCode: "PRACTICE_RUN_NOT_FOUND" };
  if (run.status !== "SUCCEEDED") return { ok: false, reasonCode: "PRACTICE_RUN_NOT_SUCCEEDED" };

  const scoreStr = input.score.toFixed(2);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(practiceRuns)
      .set({
        humanReviewScore: scoreStr,
        humanReviewedByUserId: input.reviewerUserId,
        humanReviewedAt: now,
        humanReviewNotes: input.notes ?? null,
      })
      .where(eq(practiceRuns.id, input.practiceRunId));

    await tx.insert(auditEvents).values({
      id: generateId<string>(),
      organisationId: input.organisationId,
      actor: input.reviewerUserId,
      action: "practice_run.reviewed",
      aggregateType: "practice_run",
      aggregateId: input.practiceRunId,
      priorStateSummary: { humanReviewScore: run.humanReviewScore },
      newStateSummary: { humanReviewScore: scoreStr },
      reason: input.notes ?? null,
      createdAt: now,
    });
  });

  return { ok: true };
}

export interface PromptSummary {
  id: string;
  role: string;
  semanticVersion: string;
  content: string;
  status: string;
  createdAt: Date;
}

/**
 * First-ever exposure of prompt content via API (confirmed: no existing
 * route reads `prompts` — only the worker's internal `loadApprovedPrompt`
 * does). `prompts` is a deliberate platform-shared table with no owning
 * organisation, so this is a deliberate call, not an extension of an
 * existing convention (ADR 0010) — includes DRAFT content, since a
 * practice run needs to be able to test a challenger prompt, not just the
 * currently-APPROVED one.
 */
export async function listPromptsForRole(db: Database, role: string): Promise<PromptSummary[]> {
  return db.select().from(prompts).where(eq(prompts.role, role)).orderBy(prompts.createdAt);
}
