import { Queue } from "bullmq";
import type { JobPublisher, RoutedJob } from "../outbox-relay.js";
import type { QueueName } from "../queues.js";

export interface BullMqConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
}

/**
 * Parses a redis:// or rediss:// URL into the connection shape BullMQ's
 * ioredis client expects. Managed Redis (e.g. Railway) requires the
 * password carried in the URL — dropping it here doesn't fail fast, it
 * leaves ioredis retrying an unauthenticated connection forever, which
 * hangs any caller (e.g. queue-depth reads) with no visible error.
 */
export function parseRedisUrl(url: string): BullMqConnection {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

/**
 * Publishes routed outbox jobs onto BullMQ. Queues are created lazily and
 * cached, so a long-running relay opens one connection per queue rather
 * than one per event.
 */
export class BullMqPublisher implements JobPublisher {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: BullMqConnection) {}

  private queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, { connection: this.connection });
    this.queues.set(name, queue);
    return queue;
  }

  async publish(job: RoutedJob): Promise<void> {
    await this.queueFor(job.queue).add(job.queue, job.data, {
      // Deterministic id: a relay retry re-adds the same job id, which
      // BullMQ ignores rather than duplicating the work (CLAUDE.md 3.6).
      jobId: job.jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
