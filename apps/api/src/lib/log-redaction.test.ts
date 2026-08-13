import { describe, expect, it } from "vitest";
import { redactSseTicket, redactWebhookToken } from "./log-redaction.js";

describe("redactWebhookToken", () => {
  it("redacts the token path segment on the TradingView webhook route", () => {
    const url = "/v1/webhooks/tradingview/QWxhZGRpbjpvcGVuc2VzYW1l-secret_token";
    expect(redactWebhookToken(url)).toBe("/v1/webhooks/tradingview/[redacted]");
  });

  it("preserves a trailing query string without leaking it either", () => {
    const url = "/v1/webhooks/tradingview/abc123?foo=bar";
    expect(redactWebhookToken(url)).toBe("/v1/webhooks/tradingview/[redacted]?foo=bar");
  });

  it("leaves unrelated routes untouched", () => {
    expect(redactWebhookToken("/v1/forward-deployments/abc")).toBe("/v1/forward-deployments/abc");
    expect(redactWebhookToken("/health")).toBe("/health");
  });
});

describe("redactSseTicket", () => {
  it("redacts the ticket path segment on the SSE stream route", () => {
    const url = "/v1/events/stream/QWxhZGRpbjpvcGVuc2VzYW1l-secret_ticket";
    expect(redactSseTicket(url)).toBe("/v1/events/stream/[redacted]");
  });

  it("preserves a trailing query string (cursor, aggregateId) without leaking the ticket", () => {
    const url = "/v1/events/stream/abc123?cursor=019ff3ce-a611-74b9-8d02-e0d1d2c8304d&aggregateId=xyz";
    expect(redactSseTicket(url)).toBe("/v1/events/stream/[redacted]?cursor=019ff3ce-a611-74b9-8d02-e0d1d2c8304d&aggregateId=xyz");
  });

  it("leaves unrelated routes, including the webhook route, untouched", () => {
    expect(redactSseTicket("/v1/forward-deployments/abc")).toBe("/v1/forward-deployments/abc");
    expect(redactSseTicket("/v1/webhooks/tradingview/abc123")).toBe("/v1/webhooks/tradingview/abc123");
    expect(redactSseTicket("/health")).toBe("/health");
  });
});
