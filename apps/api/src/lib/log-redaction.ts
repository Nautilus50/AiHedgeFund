const WEBHOOK_TOKEN_PATH = /^(\/v1\/webhooks\/tradingview\/)[^/?]+/;

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
