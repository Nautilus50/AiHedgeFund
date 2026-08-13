import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { outboxEvents } from "@arf-os/db";

/** All-zero UUID sorts before every real UUIDv7 id — a safe "no cursor yet" sentinel. */
export const ZERO_CURSOR = "00000000-0000-0000-0000-000000000000";

const POLL_BATCH_SIZE = 200;

export interface OutboxNotification {
  id: string;
  eventType: string;
  aggregateId: string;
  organisationId: string;
  createdAt: Date;
}

type Listener = (event: OutboxNotification) => void;

interface Subscriber {
  organisationId: string;
  aggregateId: string | undefined;
  lastSentId: string;
  onEvent: Listener;
}

/**
 * Pure decision extracted from `SseHub.dispatch` for direct unit testing
 * without a database: is `row` both in scope for `subscriber` (matching
 * organisation, and matching aggregate if the subscriber asked for one) and
 * newer than the last one it was sent?
 */
export function matchesSubscriber(
  row: Pick<OutboxNotification, "id" | "organisationId" | "aggregateId">,
  subscriber: Pick<Subscriber, "organisationId" | "aggregateId" | "lastSentId">,
): boolean {
  if (subscriber.organisationId !== row.organisationId) return false;
  if (subscriber.aggregateId !== undefined && subscriber.aggregateId !== row.aggregateId) return false;
  // A row can land in both a subscriber's catch-up read and the first live
  // tick if timed unluckily — UUIDv7's lexicographic order matches creation
  // order, so a plain string comparison is enough to skip anything already sent.
  if (row.id <= subscriber.lastSentId) return false;
  return true;
}

const NOTIFICATION_COLUMNS = {
  id: outboxEvents.id,
  eventType: outboxEvents.eventType,
  aggregateId: outboxEvents.aggregateId,
  organisationId: outboxEvents.organisationId,
  createdAt: outboxEvents.createdAt,
};

/** The shared poller's own read: unscoped, filtered per-subscriber in memory (see `SseHub.dispatch`). */
async function queryPublished(db: Database, afterId: string, limit: number): Promise<OutboxNotification[]> {
  return db
    .select(NOTIFICATION_COLUMNS)
    .from(outboxEvents)
    .where(and(eq(outboxEvents.status, "PUBLISHED"), gt(outboxEvents.id, afterId)))
    .orderBy(asc(outboxEvents.id))
    .limit(limit);
}

/** A single subscriber's catch-up read, scoped in SQL — cheap even for a very stale cursor, since it only ever touches one organisation's rows. */
async function queryPublishedForSubscriber(
  db: Database,
  organisationId: string,
  aggregateId: string | undefined,
  afterId: string,
  limit: number,
): Promise<OutboxNotification[]> {
  return db
    .select(NOTIFICATION_COLUMNS)
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.status, "PUBLISHED"),
        eq(outboxEvents.organisationId, organisationId),
        gt(outboxEvents.id, afterId),
        aggregateId === undefined ? undefined : eq(outboxEvents.aggregateId, aggregateId),
      ),
    )
    .orderBy(asc(outboxEvents.id))
    .limit(limit);
}

/**
 * Frames one notification as a `text/event-stream` message. The `id:`
 * field is what makes the stream resumable — a reconnecting client sends
 * it back as `cursor` (CLAUDE.md 17.4). The payload is deliberately thin —
 * `{aggregateId, occurredAt}`, never computed state — the client reacts by
 * refetching the affected resource (ADR 0007).
 */
export function formatSseEvent(event: OutboxNotification): string {
  const data = JSON.stringify({ aggregateId: event.aggregateId, occurredAt: event.createdAt.toISOString() });
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}

/**
 * Delivers SSE notifications without one Postgres connection per open
 * connection. `packages/db/src/client.ts` caps the pool at 10, shared with
 * every ordinary REST request — a per-connection polling loop would keep
 * that pool saturated under a handful of open tabs. Instead, one shared
 * poller per API process reads the outbox once and fans out in memory
 * (ADR 0007).
 *
 * Only ever sees rows the outbox relay has already marked PUBLISHED — the
 * relay is what turns a written domain event into something a subscriber
 * can be notified about, same as it always was for queue-routed events.
 */
export class SseHub {
  private readonly subscribers = new Set<Subscriber>();
  private globalCursor = ZERO_CURSOR;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    private readonly pollIntervalMs = 1000,
  ) {}

  /** Starts from "now" (the current max id), not the beginning of history — resuming a specific subscriber's own gap is `subscribe`'s job, not the poller's. */
  async start(): Promise<void> {
    if (this.timer) return;

    const [latest] = await this.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .orderBy(desc(outboxEvents.id))
      .limit(1);
    this.globalCursor = latest?.id ?? ZERO_CURSOR;

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.subscribers.size === 0) return;

    const rows = await queryPublished(this.db, this.globalCursor, POLL_BATCH_SIZE);
    if (rows.length === 0) return;

    const last = rows[rows.length - 1];
    if (last) this.globalCursor = last.id;
    for (const row of rows) {
      this.dispatch(row);
    }
  }

  private dispatch(row: OutboxNotification): void {
    for (const subscriber of this.subscribers) {
      if (!matchesSubscriber(row, subscriber)) continue;
      subscriber.lastSentId = row.id;
      subscriber.onEvent(row);
    }
  }

  /**
   * Closes the gap between the client's last-seen id and "now" with one
   * scoped catch-up read, then attaches to the live fan-out. Returns an
   * unsubscribe function.
   */
  async subscribe(
    organisationId: string,
    aggregateId: string | undefined,
    cursor: string | undefined,
    onEvent: Listener,
  ): Promise<() => void> {
    let lastSentId = cursor ?? ZERO_CURSOR;

    const catchUpRows = await queryPublishedForSubscriber(this.db, organisationId, aggregateId, lastSentId, POLL_BATCH_SIZE);
    for (const row of catchUpRows) {
      onEvent(row);
      lastSentId = row.id;
    }

    const subscriber: Subscriber = { organisationId, aggregateId, lastSentId, onEvent };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}
