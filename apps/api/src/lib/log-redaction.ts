const WEBHOOK_TOKEN_PATH = /^(\/v1\/webhooks\/tradingview\/)[^/?]+/;
const SSE_TICKET_PATH = /^(\/v1\/events\/stream\/)[^/?]+/;

/**
 * The TradingView webhook route carries its high-entropy auth token as a
 * URL path segment (TradingView's alert UI can't send custom headers) —
 * without this, Fastify's default request logger would write the plaintext
 * token into every log line for that route, defeating "only its hash is
 * ever persisted" (CLAUDE.md 19: never log secrets).
 */
export function redactWebhookToken(url: string): string {
  return url.replace(WEBHOOK_TOKEN_PATH, "$1[redacted]");
}

/**
 * Same problem, same fix, for the SSE ticket (ADR 0007): browser
 * `EventSource` can't set an `Authorization` header, so the short-lived
 * single-use ticket travels as a URL path segment instead — this keeps it
 * out of request logs.
 */
export function redactSseTicket(url: string): string {
  return url.replace(SSE_TICKET_PATH, "$1[redacted]");
}
