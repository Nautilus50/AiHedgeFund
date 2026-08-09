import { z } from "zod";

/**
 * A single independently-calculated metric value (spec 12.5, 14.5). Every
 * metric states its scope so incompatible scopes are never compared
 * silently (CLAUDE.md 14).
 */
export const MetricScope = z.enum([
  "RUN",
  "SEGMENT",
  "STRATEGY_VERSION",
  "SYMBOL",
  "PARAMETER_SET",
  "FORWARD_DEPLOYMENT",
  "PORTFOLIO",
]);
export type MetricScope = z.infer<typeof MetricScope>;

/**
 * Duration units are deliberately distinct: a metric measured in hours must
 * never be labelled `days` (CLAUDE.md 14 — "Explicit units"; 7.4 — include
 * units wherever ambiguity exists).
 */
export const MetricUnit = z.enum(["currency", "percent", "ratio", "count", "hours", "days", "bars"]);
export type MetricUnit = z.infer<typeof MetricUnit>;

export const MetricSnapshot = z.object({
  id: z.string().uuid(),
  metricName: z.string().min(1),
  value: z.number(),
  unit: MetricUnit,
  calculationVersion: z.string().min(1),
  scopeType: MetricScope,
  scopeId: z.string().uuid(),
  computedAt: z.string().datetime(),
});
export type MetricSnapshot = z.infer<typeof MetricSnapshot>;
