import { describe, expect, it } from "vitest";
import { redactWebhookToken } from "./log-redaction.js";

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
