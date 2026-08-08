import { and, eq, gt, inArray, or } from "drizzle-orm";
import { canonicalHash, generateId, sha256Hex, StrategyDefinition } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  pineRevisions,
  strategies,
  strategyDefinitions,
  strategyLineage,
  strategyVersions,
} from "@arf-os/db";
import { buildPage, clampPageSize, decodeCursor, type Page } from "../lib/pagination.js";

/**
 * Content hash of a Pine source string. Plain sha256 of the raw text — not
 * canonicalized JSON, since Pine source is not JSON and whitespace/formatting
 * differences are meaningful (a reformatted script is a different revision).
 */
export function hashPineSource(source: string): string {
  return sha256Hex(source);
}

/** Content hash of an SDL document, independent of key order (CLAUDE.md 3.1). */
export function hashStrategyDefinition(definition: StrategyDefinition): string {
  return canonicalHash(definition);
}

/** Content hash of a Pine manifest, independent of key order. */
export function hashPineManifest(manifest: unknown): string {
  return canonicalHash(manifest);
}

export interface CreateStrategyInput {
  organisationId: string;
  campaignId: string;
  name: string;
}

export interface CreateStrategyResult {
  strategyId: string;
  strategyVersionId: string;
  versionNumber: number;
}

/**
 * Creates a new Strategy and its first (root) StrategyVersion atomically.
 * The version starts in CAMPAIGN_BACKLOG — moving it forward is exclusively
 * packages/workflow's job (CLAUDE.md 10), never this service's.
 */
export async function createStrategy(
  db: Database,
  input: CreateStrategyInput,
): Promise<CreateStrategyResult> {
  return db.transaction(async (tx) => {
    const strategyId = generateId<string>();
    const strategyVersionId = generateId<string>();

    await tx.insert(strategies).values({
      id: strategyId,
      organisationId: input.organisationId,
      campaignId: input.campaignId,
      name: input.name,
    });

    await tx.insert(strategyVersions).values({
      id: strategyVersionId,
      strategyId,
      parentVersionId: null,
      versionNumber: 1,
      workflowState: "CAMPAIGN_BACKLOG",
    });

    return { strategyId, strategyVersionId, versionNumber: 1 };
  });
}

export interface CreateChildVersionInput {
  strategyId: string;
  parentVersionId: string;
  changeCategory: string;
  changedFields: string[];
  motivatingEvidenceIds: string[];
  changeReason: string;
  createdByAgentRunId?: string;
}

/**
 * Creates a new immutable StrategyVersion as a child of an existing one.
 * The parent row is never updated — only referenced (CLAUDE.md 3.1 / 26 —
 * "Never mutate a tested strategy version").
 */
export async function createChildStrategyVersion(
  db: Database,
  input: CreateChildVersionInput,
): Promise<CreateStrategyResult> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ versionNumber: strategyVersions.versionNumber })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, input.parentVersionId))
      .limit(1);

    if (!parent) {
      throw new Error(`Parent strategy version ${input.parentVersionId} does not exist.`);
    }

    const strategyVersionId = generateId<string>();

    await tx.insert(strategyVersions).values({
      id: strategyVersionId,
      strategyId: input.strategyId,
      parentVersionId: input.parentVersionId,
      versionNumber: parent.versionNumber + 1,
      workflowState: "CAMPAIGN_BACKLOG",
      changeReason: input.changeReason,
      createdByAgentRunId: input.createdByAgentRunId,
    });

    await tx.insert(strategyLineage).values({
      id: generateId<string>(),
      strategyVersionId,
      parentVersionId: input.parentVersionId,
      changeCategory: input.changeCategory,
      changedFields: input.changedFields,
      motivatingEvidenceIds: input.motivatingEvidenceIds,
    });

    return { strategyId: input.strategyId, strategyVersionId, versionNumber: parent.versionNumber + 1 };
  });
}

export type SaveStrategyDefinitionResult =
  | { ok: true; definitionHash: string }
  | { ok: false; reasonCode: "INVALID_DEFINITION"; issues: string[] };

/**
 * Validates and stores an SDL document for a strategy version. The unique
 * constraint on strategy_definitions.strategy_version_id (packages/db)
 * makes a second call for the same version fail at the database rather than
 * silently overwrite it — SDL documents are immutable per version.
 */
export async function saveStrategyDefinition(
  db: Database,
  input: { strategyVersionId: string; definition: unknown },
): Promise<SaveStrategyDefinitionResult> {
  const parsed = StrategyDefinition.safeParse(input.definition);
  if (!parsed.success) {
    return {
      ok: false,
      reasonCode: "INVALID_DEFINITION",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const definitionHash = hashStrategyDefinition(parsed.data);

  await db.transaction(async (tx) => {
    await tx.insert(strategyDefinitions).values({
      id: generateId<string>(),
      strategyVersionId: input.strategyVersionId,
      definition: parsed.data,
      definitionHash,
    });

    await tx
      .update(strategyVersions)
      .set({ definitionHash })
      .where(eq(strategyVersions.id, input.strategyVersionId));
  });

  return { ok: true, definitionHash };
}

export interface SavePineRevisionInput {
  strategyVersionId: string;
  source: string;
  manifest: unknown;
  createdByUserId?: string;
}

export interface SavePineRevisionResult {
  pineRevisionId: string;
  sourceHash: string;
  manifestHash: string;
}

/**
 * Stores an immutable Pine Script revision + manifest for a strategy
 * version (CLAUDE.md 12 — "Create a new revision rather than editing a
 * tested revision in place"). The unique constraint on
 * pine_revisions.strategy_version_id enforces one revision per version at
 * the database level.
 */
export async function savePineRevision(
  db: Database,
  input: SavePineRevisionInput,
): Promise<SavePineRevisionResult> {
  const sourceHash = hashPineSource(input.source);
  const manifestHash = hashPineManifest(input.manifest);
  const pineRevisionId = generateId<string>();

  await db.transaction(async (tx) => {
    await tx.insert(pineRevisions).values({
      id: pineRevisionId,
      strategyVersionId: input.strategyVersionId,
      source: input.source,
      sourceHash,
      manifest: input.manifest,
      manifestHash,
      createdByUserId: input.createdByUserId,
    });

    await tx
      .update(strategyVersions)
      .set({ pineSourceHash: sourceHash, manifestHash })
      .where(eq(strategyVersions.id, input.strategyVersionId));
  });

  return { pineRevisionId, sourceHash, manifestHash };
}

/** Organisation-scoped fetch — joins through `strategies` so a caller can never read another org's version by guessing an id (CLAUDE.md 19.1). */
export async function getStrategyVersion(db: Database, organisationId: string, strategyVersionId: string) {
  const [row] = await db
    .select({
      id: strategyVersions.id,
      strategyId: strategyVersions.strategyId,
      parentVersionId: strategyVersions.parentVersionId,
      versionNumber: strategyVersions.versionNumber,
      workflowState: strategyVersions.workflowState,
      definitionHash: strategyVersions.definitionHash,
      pineSourceHash: strategyVersions.pineSourceHash,
      manifestHash: strategyVersions.manifestHash,
      changeReason: strategyVersions.changeReason,
      createdAt: strategyVersions.createdAt,
    })
    .from(strategyVersions)
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategyVersions.id, strategyVersionId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  return row;
}

export async function getStrategyLineage(db: Database, organisationId: string, strategyVersionId: string) {
  return db
    .select({
      id: strategyLineage.id,
      strategyVersionId: strategyLineage.strategyVersionId,
      parentVersionId: strategyLineage.parentVersionId,
      changeCategory: strategyLineage.changeCategory,
      changedFields: strategyLineage.changedFields,
      motivatingEvidenceIds: strategyLineage.motivatingEvidenceIds,
      createdAt: strategyLineage.createdAt,
    })
    .from(strategyLineage)
    .innerJoin(strategyVersions, eq(strategyVersions.id, strategyLineage.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategyLineage.strategyVersionId, strategyVersionId), eq(strategies.organisationId, organisationId)));
}

export interface StrategyListItem {
  id: string;
  name: string;
  campaignId: string;
  createdAt: Date;
  latestVersionId: string | undefined;
  latestVersionNumber: number | undefined;
  latestWorkflowState: string | undefined;
}

export interface ListStrategiesInput {
  campaignId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type ListStrategiesResult =
  | { ok: true; page: Page<{ id: string; createdAt: Date } & StrategyListItem> }
  | { ok: false; reasonCode: "INVALID_CURSOR" };

/**
 * Organisation-scoped, cursor-paginated strategy list, each row annotated
 * with its highest-versionNumber StrategyVersion. Two queries total
 * regardless of page size: one for the page of strategies, one batched
 * `IN (...)` lookup for their versions — no N+1.
 */
export async function listStrategies(
  db: Database,
  organisationId: string,
  input: ListStrategiesInput,
): Promise<ListStrategiesResult> {
  const limit = clampPageSize(input.limit);

  let cursorClause;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) {
      return { ok: false, reasonCode: "INVALID_CURSOR" };
    }
    const { createdAtIso, id } = decoded.cursor;
    const createdAtDate = new Date(createdAtIso);
    cursorClause = or(
      gt(strategies.createdAt, createdAtDate),
      and(eq(strategies.createdAt, createdAtDate), gt(strategies.id, id)),
    );
  }

  const baseClause = input.campaignId
    ? and(eq(strategies.organisationId, organisationId), eq(strategies.campaignId, input.campaignId))
    : eq(strategies.organisationId, organisationId);

  const strategyRows = await db
    .select()
    .from(strategies)
    .where(cursorClause ? and(baseClause, cursorClause) : baseClause)
    .orderBy(strategies.createdAt, strategies.id)
    .limit(limit + 1);

  const page = buildPage(strategyRows, limit);
  if (page.items.length === 0) {
    return { ok: true, page: { items: [], nextCursor: page.nextCursor } };
  }

  const versionRows = await db
    .select({
      strategyId: strategyVersions.strategyId,
      id: strategyVersions.id,
      versionNumber: strategyVersions.versionNumber,
      workflowState: strategyVersions.workflowState,
    })
    .from(strategyVersions)
    .where(
      inArray(
        strategyVersions.strategyId,
        page.items.map((s) => s.id),
      ),
    );

  const latestByStrategy = new Map<string, (typeof versionRows)[number]>();
  for (const version of versionRows) {
    const existing = latestByStrategy.get(version.strategyId);
    if (!existing || version.versionNumber > existing.versionNumber) {
      latestByStrategy.set(version.strategyId, version);
    }
  }

  const items = page.items.map((strategy) => {
    const latest = latestByStrategy.get(strategy.id);
    return {
      ...strategy,
      latestVersionId: latest?.id,
      latestVersionNumber: latest?.versionNumber,
      latestWorkflowState: latest?.workflowState,
    };
  });

  return { ok: true, page: { items, nextCursor: page.nextCursor } };
}
