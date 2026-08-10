import { connect } from "node:net";
import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { QUEUE_NAMES, deterministicJobId } from "../queues.js";
import { BullMqPublisher, parseRedisUrl } from "./bullmq-publisher.js";

const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";

const PROBE_TIMEOUT_MS = 1_000;

/**
 * Bounded reachability check, deliberately at the TCP level rather than
 * through BullMQ.
 *
 * ioredis retries a refused connection forever by default, so a
 * `queue.waitUntilReady()` probe never rejects and a try/catch around it
 * never fires. That matters more than usual here: this guard runs during
 * module evaluation, before any `describe`, where vitest's testTimeout and
 * hookTimeout do not apply — so an unbounded wait hangs the entire run
 * instead of failing it. That is precisely how this suite behaved with no
 * Redis running.
 *
 * A raw socket cannot retry-loop and cannot outlive its own timeout. If
 * something other than Redis is listening on the port, the suite then fails
 * loudly on its real assertions, which is the right failure mode — unlike a
 * silent hang.
 *
 * Production behaviour is deliberately left alone: a relay *should* retry
 * indefinitely so it survives a Redis blip. Only this probe fails fast.
 */
function redisReachable(): Promise<boolean> {
  const { host, port } = parseRedisUrl(REDIS_URL);

  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

const available = await redisReachable();
const TEST_QUEUE = QUEUE_NAMES.readModelRefresh;

describe.skipIf(!available)("BullMqPublisher (integration)", () => {
  let publisher: BullMqPublisher;
  let queue: Queue;

  beforeAll(async () => {
    publisher = new BullMqPublisher(parseRedisUrl(REDIS_URL));
    queue = new Queue(TEST_QUEUE, { connection: parseRedisUrl(REDIS_URL) });
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await publisher.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it("publishes a job that a worker actually receives", async () => {
    const payload = { organisationId: generateId<string>(), aggregateType: "strategy_version" };
    const jobId = deterministicJobId(TEST_QUEUE, generateId<string>());

    await publisher.publish({ queue: TEST_QUEUE, jobId, data: payload });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(
        TEST_QUEUE,
        async (job) => {
          resolve(job.data as Record<string, unknown>);
          await worker.close();
        },
        { connection: parseRedisUrl(REDIS_URL) },
      );
      worker.on("failed", (_job, error) => reject(error));
      setTimeout(() => reject(new Error("timed out waiting for job")), 10_000);
    });

    expect(received).toEqual(payload);
  });

  it("dedupes a re-published job by its deterministic id (relay retry safety)", async () => {
    const jobId = deterministicJobId(TEST_QUEUE, "stable-row-id");
    const data = { organisationId: generateId<string>() };

    // A relay that crashed after publishing but before marking the row
    // published will re-publish on restart. BullMQ must collapse it.
    await publisher.publish({ queue: TEST_QUEUE, jobId, data });
    await publisher.publish({ queue: TEST_QUEUE, jobId, data });

    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const total = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    expect(total).toBe(1);
  });

  it("retries a failing job and succeeds on a later attempt", async () => {
    const jobId = deterministicJobId(TEST_QUEUE, generateId<string>());
    await publisher.publish({ queue: TEST_QUEUE, jobId, data: { attempt: "retry-test" } });

    let attempts = 0;

    const succeeded = await new Promise<boolean>((resolve, reject) => {
      const worker = new Worker(
        TEST_QUEUE,
        async () => {
          attempts += 1;
          // Fail the first attempt; the publisher configures 3 attempts with
          // exponential backoff, so BullMQ should hand it back to us.
          if (attempts < 2) {
            throw new Error("transient failure");
          }
          return "ok";
        },
        { connection: parseRedisUrl(REDIS_URL) },
      );

      worker.on("completed", () => {
        void worker.close().then(() => resolve(true));
      });
      setTimeout(() => {
        void worker.close().then(() => reject(new Error("timed out waiting for retry")));
      }, 15_000);
    });

    expect(succeeded).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
