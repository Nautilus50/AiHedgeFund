import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./queues.js";
import {
  relayOutboxBatch,
  routeOutboxEvent,
  type JobPublisher,
  type OutboxRow,
  type OutboxStore,
  type RoutedJob,
} from "./outbox-relay.js";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "row-1",
    eventType: "report_upload.parsed",
    eventVersion: "1.0.0",
    aggregateId: "agg-1",
    correlationId: "corr-1",
    actor: "user-1",
    payload: { hello: "world" },
    ...overrides,
  };
}

class FakeStore implements OutboxStore {
  publishedIds: string[] = [];
  failures: { id: string; error: string }[] = [];

  constructor(private readonly rows: OutboxRow[]) {}

  async claimPending(limit: number): Promise<OutboxRow[]> {
    return this.rows.slice(0, limit);
  }
  async markPublished(ids: string[]): Promise<void> {
    this.publishedIds.push(...ids);
  }
  async markFailed(id: string, error: string): Promise<void> {
    this.failures.push({ id, error });
  }
}

class FakePublisher implements JobPublisher {
  published: RoutedJob[] = [];
  constructor(private readonly failOnJobId?: string) {}

  async publish(job: RoutedJob): Promise<void> {
    if (this.failOnJobId && job.jobId === this.failOnJobId) {
      throw new Error("broker unavailable");
    }
    this.published.push(job);
  }
}

describe("routeOutboxEvent", () => {
  it("routes report_upload.parsed to trade normalisation", () => {
    expect(routeOutboxEvent(row())?.queue).toBe(QUEUE_NAMES.tradeNormalisation);
  });

  it("routes the analytics chain in order", () => {
    expect(routeOutboxEvent(row({ eventType: "trades.normalised" }))?.queue).toBe(QUEUE_NAMES.equityReconstruction);
    expect(routeOutboxEvent(row({ eventType: "equity.reconstructed" }))?.queue).toBe(QUEUE_NAMES.metricCalculation);
    expect(routeOutboxEvent(row({ eventType: "metrics.calculated" }))?.queue).toBe(QUEUE_NAMES.parityCalculation);
  });

  it("routes backtest_run.local_execution_requested to local runner execution", () => {
    expect(routeOutboxEvent(row({ eventType: "backtest_run.local_execution_requested" }))?.queue).toBe(
      QUEUE_NAMES.localRunnerExecution,
    );
  });

  it("routes workflow and decision events to read-model refresh", () => {
    expect(routeOutboxEvent(row({ eventType: "strategy_version.transitioned" }))?.queue).toBe(
      QUEUE_NAMES.readModelRefresh,
    );
    expect(routeOutboxEvent(row({ eventType: "committee_decision.created" }))?.queue).toBe(
      QUEUE_NAMES.readModelRefresh,
    );
  });

  it("routes practice_run.requested to the practice-run queue", () => {
    expect(routeOutboxEvent(row({ eventType: "practice_run.requested" }))?.queue).toBe(QUEUE_NAMES.practiceRun);
  });

  it("routes agent_run.requested to the agent-run queue", () => {
    expect(routeOutboxEvent(row({ eventType: "agent_run.requested" }))?.queue).toBe(QUEUE_NAMES.agentRun);
  });

  it("returns undefined for an event nobody subscribes to", () => {
    expect(routeOutboxEvent(row({ eventType: "some.future.event" }))).toBeUndefined();
  });

  it("derives the job id from the outbox row id, so a retry dedupes", () => {
    const first = routeOutboxEvent(row({ id: "row-abc" }));
    const second = routeOutboxEvent(row({ id: "row-abc" }));
    expect(first?.jobId).toBe(second?.jobId);
    expect(first?.jobId).toContain("row-abc");
  });

  it("never emits a job id containing ':' — BullMQ rejects those outright", () => {
    // Regression: the original separator was ":", which BullMQ refuses with
    // "Custom Id cannot contain :". The fake publisher in these tests does
    // not enforce that rule, so only a live run caught it.
    const eventTypes = [
      "report_upload.parsed",
      "trades.normalised",
      "equity.reconstructed",
      "metrics.calculated",
      "strategy_version.transitioned",
      "committee_decision.created",
    ];

    for (const eventType of eventTypes) {
      const routed = routeOutboxEvent(row({ eventType }));
      expect(routed?.jobId).toBeDefined();
      expect(routed?.jobId).not.toContain(":");
    }
  });
});

describe("relayOutboxBatch", () => {
  it("publishes every routable row and marks them published", async () => {
    const store = new FakeStore([row({ id: "a" }), row({ id: "b" })]);
    const publisher = new FakePublisher();

    const result = await relayOutboxBatch(store, publisher);

    expect(result).toEqual({ claimed: 2, published: 2, skipped: 0, failed: 0 });
    expect(publisher.published).toHaveLength(2);
    expect(store.publishedIds).toEqual(["a", "b"]);
  });

  it("marks an unroutable event published rather than retrying it forever", async () => {
    const store = new FakeStore([row({ id: "a", eventType: "unknown.event" })]);
    const publisher = new FakePublisher();

    const result = await relayOutboxBatch(store, publisher);

    expect(result).toEqual({ claimed: 1, published: 0, skipped: 1, failed: 0 });
    expect(publisher.published).toHaveLength(0);
    expect(store.publishedIds).toEqual(["a"]);
  });

  it("isolates a publish failure: the poison row fails, the rest still go through", async () => {
    const rows = [row({ id: "a" }), row({ id: "poison" }), row({ id: "c" })];
    const store = new FakeStore(rows);
    const publisher = new FakePublisher(`${QUEUE_NAMES.tradeNormalisation}__poison`);

    const result = await relayOutboxBatch(store, publisher);

    expect(result).toEqual({ claimed: 3, published: 2, skipped: 0, failed: 1 });
    expect(store.failures).toEqual([{ id: "poison", error: "broker unavailable" }]);
    // The healthy rows are still marked published — one bad event must not stall the queue.
    expect(store.publishedIds).toEqual(["a", "c"]);
  });

  it("never calls markPublished when the batch is empty", async () => {
    const store = new FakeStore([]);
    const result = await relayOutboxBatch(store, new FakePublisher());

    expect(result).toEqual({ claimed: 0, published: 0, skipped: 0, failed: 0 });
    expect(store.publishedIds).toEqual([]);
  });

  it("respects the batch size", async () => {
    const store = new FakeStore([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    const result = await relayOutboxBatch(store, new FakePublisher(), 2);
    expect(result.claimed).toBe(2);
  });
});
