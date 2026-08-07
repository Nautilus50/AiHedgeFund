import { describe, expect, it } from "vitest";
import { SignalEvent, signalIdempotencyKey } from "./signal-event.js";
import { generateId } from "./ids.js";

describe("SignalEvent", () => {
  it("accepts a well-formed alert payload (spec 11.10)", () => {
    const event = {
      schema: "arf.signal.v1",
      deploymentId: generateId(),
      strategyVersionId: generateId(),
      eventId: "deterministic-id",
      eventType: "ENTRY_LONG",
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      barTime: "2026-08-04T17:00:00.000Z",
      sentAt: "2026-08-04T18:00:01.000Z",
      price: 100000.0,
      quantityModel: "percent_of_equity",
      stopPrice: 98000.0,
      targetPrice: 104000.0,
    };
    expect(SignalEvent.safeParse(event).success).toBe(true);
  });

  it("rejects zero/negative price", () => {
    const event = {
      schema: "arf.signal.v1",
      deploymentId: generateId(),
      strategyVersionId: generateId(),
      eventId: "id",
      eventType: "ENTRY_LONG",
      symbol: "BTCUSDT",
      timeframe: "60",
      barTime: "2026-08-04T17:00:00.000Z",
      sentAt: "2026-08-04T18:00:01.000Z",
      price: 0,
      quantityModel: "percent_of_equity",
    };
    expect(SignalEvent.safeParse(event).success).toBe(false);
  });
});

describe("signalIdempotencyKey", () => {
  const base = {
    deploymentId: "d1" as const,
    strategyVersionId: "v1" as const,
    eventType: "ENTRY_LONG" as const,
    barTime: "2026-08-04T17:00:00.000Z",
  };

  it("is deterministic for identical inputs (spec 13.7)", () => {
    expect(signalIdempotencyKey(base, "order-1")).toBe(signalIdempotencyKey(base, "order-1"));
  });

  it("differs when the order id differs", () => {
    expect(signalIdempotencyKey(base, "order-1")).not.toBe(signalIdempotencyKey(base, "order-2"));
  });

  it("differs when the bar time differs", () => {
    const other = { ...base, barTime: "2026-08-04T18:00:00.000Z" };
    expect(signalIdempotencyKey(base, "order-1")).not.toBe(signalIdempotencyKey(other, "order-1"));
  });
});
