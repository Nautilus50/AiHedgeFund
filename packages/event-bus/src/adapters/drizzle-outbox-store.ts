import { sql } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import type { OutboxRow, OutboxStore } from "../outbox-relay.js";

type ClaimedRow = {
  id: string;
  event_type: string;
  event_version: string;
  aggregate_id: string;
  correlation_id: string;
  actor: string;
  payload: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Postgres-backed outbox store.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes it safe to run several relay
 * instances at once: each transaction claims a disjoint set of rows instead
 * of blocking on, or double-publishing, the same ones.
 */
export class DrizzleOutboxStore implements OutboxStore {
  constructor(private readonly db: Database) {}

  /**
   * Atomically claims a batch: the CTE locks PENDING rows with SKIP LOCKED
   * and the outer UPDATE flips them to PUBLISHING in the same statement, so
   * the claim survives past commit and a concurrent relay can't pick them up.
   */
  async claimPending(limit: number): Promise<OutboxRow[]> {
    const result = await this.db.execute<ClaimedRow>(sql`
      WITH claimed AS (
        SELECT id
        FROM outbox_events
        WHERE status = 'PENDING'
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET status = 'PUBLISHING'
      FROM claimed c
      WHERE o.id = c.id
      RETURNING o.id, o.event_type, o.event_version, o.aggregate_id,
                o.correlation_id, o.actor, o.payload
    `);

    return [...result].map((row) => ({
      id: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      aggregateId: row.aggregate_id,
      correlationId: row.correlation_id,
      actor: row.actor,
      payload: row.payload,
    }));
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.execute(sql`
      UPDATE outbox_events
      SET status = 'PUBLISHED', published_at = now()
      WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE outbox_events
      SET status = 'FAILED', payload = payload || ${JSON.stringify({ relayError: error })}::jsonb
      WHERE id = ${id}::uuid
    `);
  }

  /**
   * Returns rows stranded in PUBLISHING by a relay that died mid-flight.
   * Safe to re-publish because every routed job carries a deterministic job
   * id keyed on the outbox row, so BullMQ collapses the duplicate.
   */
  async reclaimStale(olderThanSeconds = 300): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE outbox_events
      SET status = 'PENDING'
      WHERE status = 'PUBLISHING'
        AND created_at < now() - make_interval(secs => ${olderThanSeconds})
    `);
    return result.count ?? 0;
  }
}
