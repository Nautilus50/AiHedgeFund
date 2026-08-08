import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { auditEvents } from "@arf-os/db";

export interface AuditTimelineInput {
  organisationId: string;
  aggregateType: string;
  aggregateId: string;
  limit?: number;
}

/**
 * Read-only audit timeline for one aggregate, newest first. Organisation-scoped
 * per CLAUDE.md 19.1 — a caller can never read another organisation's audit
 * trail by guessing an aggregateId.
 */
export async function getAuditTimeline(db: Database, input: AuditTimelineInput) {
  const limit = Math.min(input.limit ?? 50, 200);

  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organisationId, input.organisationId),
        eq(auditEvents.aggregateType, input.aggregateType),
        eq(auditEvents.aggregateId, input.aggregateId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
