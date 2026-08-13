import { z } from "zod";

/**
 * Forward-deployment lifecycle (CLAUDE.md 16, spec Lane 7). Deliberately
 * narrower than the spec's full list: `DEGRADED` is a derived health fact
 * computed at read time (see the forward-deployments service), not a state
 * a caller sets directly, and `CONFIGURING` adds a step with no content
 * when a deployment's config is fully supplied at creation.
 */
export const ForwardDeploymentState = z.enum(["PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"]);
export type ForwardDeploymentState = z.infer<typeof ForwardDeploymentState>;

/**
 * Everything CLAUDE.md 16.2 requires a deployment to record, declared and
 * versioned. Deliberately its own shape rather than reusing `CostModel`
 * (backtest.ts) — that type bundles `slippageTicks` into the commission
 * model, which would give a forward deployment two sources of truth for
 * slippage. `stopTargetRule: "external_alert_only"` is an honest declared
 * value: TradingView's own alert is what reports a stop/target hit
 * (`SignalEvent`'s STOP_HIT/TARGET_HIT event types) — ARF-OS does not
 * simulate live stop/target monitoring against a price feed it doesn't have.
 */
export const ForwardFillModel = z.object({
  fillModelVersion: z.string().min(1),
  latencyModel: z.object({
    type: z.literal("fixed_seconds"),
    seconds: z.number().min(0),
  }),
  slippageModel: z.object({
    type: z.enum(["fixed_percent", "fixed_ticks"]),
    value: z.number().min(0),
  }),
  commissionModel: z.object({
    type: z.enum(["percent", "fixed_per_trade"]),
    value: z.number().min(0),
  }),
  quantityModel: z.discriminatedUnion("type", [
    z.object({ type: z.literal("percent_of_equity"), percent: z.number().positive().max(100) }),
    z.object({ type: z.literal("fixed"), quantity: z.number().positive() }),
    z.object({ type: z.literal("cash"), cashAmount: z.number().positive() }),
  ]),
  stopTargetRule: z.object({ type: z.literal("external_alert_only") }),
});
export type ForwardFillModel = z.infer<typeof ForwardFillModel>;

export const CreateForwardDeploymentInput = z.object({
  strategyVersionId: z.string().uuid(),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  initialCapital: z.number().positive(),
  timestampToleranceSeconds: z.number().int().positive(),
  fillModel: ForwardFillModel,
  /** Compared against realised drawdown to compute the health endpoint's strategy-performance axis. Omitted means that axis reports NOT_CONFIGURED rather than a fabricated default. */
  maxDrawdownPctAlertThreshold: z.number().positive().max(100).optional(),
});
export type CreateForwardDeploymentInput = z.infer<typeof CreateForwardDeploymentInput>;
