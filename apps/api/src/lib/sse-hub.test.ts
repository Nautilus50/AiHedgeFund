import { describe, expect, it } from "vitest";
import { formatSseEvent, matchesSubscriber, ZERO_CURSOR } from "./sse-hub.js";

const ORG_A = "019ff3ce-a000-7000-8000-000000000001";
const ORG_B = "019ff3ce-a000-7000-8000-000000000002";
const AGGREGATE_1 = "019ff3ce-a000-7000-8000-0000000000a1";
const AGGREGATE_2 = "019ff3ce-a000-7000-8000-0000000000a2";

function row(id: string, overrides: { organisationId?: string; aggregateId?: string } = {}) {
  return { id, organisationId: overrides.organisationId ?? ORG_A, aggregateId: overrides.aggregateId ?? AGGREGATE_1 };
}

function subscriber(overrides: { organisationId?: string; aggregateId?: string; lastSentId?: string } = {}) {
  return {
    organisationId: overrides.organisationId ?? ORG_A,
    aggregateId: overrides.aggregateId,
    lastSentId: overrides.lastSentId ?? ZERO_CURSOR,
  };
}

describe("matchesSubscriber", () => {
  it("delivers a row from the same organisation to a subscriber with no aggregate filter", () => {
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000010"), subscriber())).toBe(true);
  });

  it("never delivers a row from a different organisation", () => {
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000010", { organisationId: ORG_B }), subscriber())).toBe(
      false,
    );
  });

  it("filters by aggregateId when the subscriber asked for one", () => {
    const matching = row("019ff3ce-a000-7000-8000-000000000010", { aggregateId: AGGREGATE_1 });
    const other = row("019ff3ce-a000-7000-8000-000000000011", { aggregateId: AGGREGATE_2 });
    const sub = subscriber({ aggregateId: AGGREGATE_1 });

    expect(matchesSubscriber(matching, sub)).toBe(true);
    expect(matchesSubscriber(other, sub)).toBe(false);
  });

  it("delivers every aggregate when the subscriber asked for none", () => {
    const sub = subscriber();
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000010", { aggregateId: AGGREGATE_1 }), sub)).toBe(true);
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000011", { aggregateId: AGGREGATE_2 }), sub)).toBe(true);
  });

  it("never re-delivers a row at or before the subscriber's last-sent id", () => {
    const sub = subscriber({ lastSentId: "019ff3ce-a000-7000-8000-000000000010" });
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000010"), sub)).toBe(false);
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000005"), sub)).toBe(false);
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000011"), sub)).toBe(true);
  });

  it("delivers everything to a fresh subscriber with no cursor", () => {
    expect(matchesSubscriber(row("019ff3ce-a000-7000-8000-000000000001"), subscriber({ lastSentId: ZERO_CURSOR }))).toBe(
      true,
    );
  });
});

describe("formatSseEvent", () => {
  it("frames the id, event name, and a thin data payload — never computed state", () => {
    const framed = formatSseEvent({
      id: "019ff3ce-a000-7000-8000-000000000010",
      eventType: "backtest_run.completed",
      aggregateId: AGGREGATE_1,
      organisationId: ORG_A,
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(framed).toBe(
      "id: 019ff3ce-a000-7000-8000-000000000010\n" +
        "event: backtest_run.completed\n" +
        `data: {"aggregateId":"${AGGREGATE_1}","occurredAt":"2026-08-13T10:00:00.000Z"}\n\n`,
    );
  });

  it("never leaks organisationId into the wire payload", () => {
    const framed = formatSseEvent({
      id: "019ff3ce-a000-7000-8000-000000000010",
      eventType: "backtest_run.completed",
      aggregateId: AGGREGATE_1,
      organisationId: ORG_A,
      createdAt: new Date(),
    });
    expect(framed).not.toContain(ORG_A);
  });
});
