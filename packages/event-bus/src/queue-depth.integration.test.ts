import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { getQueueDepths } from "./queue-depth.js";
import { parseRedisUrl } from "./adapters/bullmq-publisher.js";
import { QUEUE_NAMES } from "./queues.js";

const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";
const PROBE_TIMEOUT_MS = 1_000;

/** Same bounded TCP-level reachability guard as bullmq-publisher.integration.test.ts — see that file for why. */
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

/**
 * Deliberately no "add a job, see it counted" case: this dev environment's
 * queues all have real, currently-running worker processes consuming from
 * them (worker-backtest, worker-analytics, worker-forward), so a job added
 * here could be picked up before this test ever reads it back — asserting
 * an exact count would be racing a process this suite doesn't control, not
 * testing `getQueueDepths` itself. What's actually this function's own
 * logic — shaping BullMQ's raw counts into one row per known queue name —
 * is what's tested below instead.
 */
describe.skipIf(!available)("getQueueDepths (integration)", () => {
  it("returns exactly one row per known queue, with non-negative counts", async () => {
    const depths = await getQueueDepths(parseRedisUrl(REDIS_URL));

    expect(depths.map((d) => d.queue).sort()).toEqual(Object.values(QUEUE_NAMES).sort());
    for (const depth of depths) {
      expect(depth.waiting).toBeGreaterThanOrEqual(0);
      expect(depth.active).toBeGreaterThanOrEqual(0);
      expect(depth.delayed).toBeGreaterThanOrEqual(0);
      expect(depth.failed).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(depth.waiting)).toBe(true);
    }
  });
});
