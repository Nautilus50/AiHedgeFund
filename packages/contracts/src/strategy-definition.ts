import { z } from "zod";

const RiskLevel = z.object({
  type: z.enum(["atr_multiple", "risk_multiple", "fixed_ticks", "fixed_percent"]),
  valueParameter: z.string().min(1),
});

const Parameter = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.enum(["int", "float", "bool", "string"]),
    default: z.union([z.number(), z.boolean(), z.string()]),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
  })
  .refine((p) => p.min <= p.max, { message: "min must be <= max", path: ["min"] });

/**
 * Strategy Definition Language (SDL) — the contract between the Strategy
 * Architect and the Pine Engineer (AI_RESEARCH_HEDGE_FUND_SPEC.md 9).
 * Mirrors schemas/strategy-definition.schema.json; any drift between the two
 * must be resolved via an ADR (CLAUDE.md 2).
 */
export const StrategyDefinition = z.object({
  schemaVersion: z.literal("1.0.0"),
  strategy: z.object({
    name: z.string().min(1).max(255),
    family: z.string().min(1),
    thesis: z.string().min(1),
    directions: z.array(z.enum(["long", "short"])).min(1),
  }),
  market: z.object({
    assetClass: z.enum(["crypto", "forex", "futures", "indices", "metals", "equities"]),
    symbols: z.array(z.string().min(1)).min(1),
    timeframe: z.string().min(1),
    timezone: z.string().min(1),
    session: z.string().min(1),
    chartType: z.literal("standard_ohlc"),
  }),
  signals: z
    .object({
      longEntry: z.string().min(1),
      shortEntry: z.string().min(1),
    })
    .catchall(z.unknown()),
  execution: z.object({
    entryOrder: z.enum(["market_next_bar", "stop", "limit"]),
    pyramiding: z.literal(0),
    allowReversal: z.boolean(),
    processOnClose: z.boolean(),
    calcOnEveryTick: z.literal(false),
  }),
  risk: z.object({
    sizingModel: z.enum(["percent_of_equity", "fixed", "cash"]),
    sizePercent: z.number().positive().max(100),
    leverage: z.number().min(1),
    stopLoss: RiskLevel,
    takeProfit: RiskLevel,
    oneStopOneTarget: z.literal(true),
  }),
  costs: z.object({
    commissionType: z.enum(["percent", "cash_per_order", "cash_per_contract"]),
    commissionValue: z.number().min(0),
    slippageTicks: z.number().int().min(0),
  }),
  parameters: z.array(Parameter),
  segments: z.object({
    warmupBars: z.number().int().min(0),
    selectionMode: z.enum([
      "fixed_split",
      "rolling_walk_forward",
      "anchored_walk_forward",
      "fixed_parameters",
    ]),
    embargoBars: z.number().int().min(0),
  }),
  falsification: z.array(z.string().min(1)).min(1),
});
export type StrategyDefinition = z.infer<typeof StrategyDefinition>;

/**
 * Computes the canonical definition hash used to detect whether an SDL
 * change requires a new StrategyVersion (CLAUDE.md 3.1).
 */
export function strategyDefinitionCanonicalJson(definition: StrategyDefinition): string {
  return JSON.stringify(definition, Object.keys(definition).sort());
}
