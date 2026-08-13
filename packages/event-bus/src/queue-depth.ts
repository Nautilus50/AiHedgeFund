import { Queue } from "bullmq";
import type { BullMqConnection } from "./adapters/bullmq-publisher.js";
import { QUEUE_NAMES, type QueueName } from "./queues.js";

export interface QueueDepth {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/**
 * Live job counts per queue (CLAUDE.md 20: "Instrument: ... queue depth").
 * Opens a short-lived `Queue` handle per name rather than reusing
 * `BullMqPublisher`'s cached ones — this is a read-only inspection call
 * from a process (the API) that never publishes, so there is no long-lived
 * connection to amortize the cost of opening one.
 */
export async function getQueueDepths(connection: BullMqConnection): Promise<QueueDepth[]> {
  const names = Object.values(QUEUE_NAMES);
  const depths = await Promise.all(
    names.map(async (queue) => {
      const handle = new Queue(queue, { connection });
      try {
        const counts = await handle.getJobCounts("waiting", "active", "delayed", "failed");
        return {
          queue,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      } finally {
        await handle.close();
      }
    }),
  );
  return depths;
}
