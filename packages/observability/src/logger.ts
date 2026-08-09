import pino, { type Logger } from "pino";

export type { Logger };

/**
 * Structured log context required on every background operation
 * (CLAUDE.md 20 / spec 18.1).
 */
export interface JobLogContext {
  traceId?: string;
  correlationId?: string;
  jobId?: string;
  campaignId?: string;
  strategyVersionId?: string;
  backtestRunId?: string;
  actor?: string;
}

/** Keys that must never reach a log sink (CLAUDE.md 19 — never log secrets). */
const REDACT_PATHS = [
  "*.secretKey",
  "*.secretAccessKey",
  "*.accessKeyId",
  "*.password",
  "*.token",
  "*.authorization",
  "req.headers.authorization",
];

export function createLogger(service: string): Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}
