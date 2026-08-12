import type { BacktestPlan, StrategyDefinition } from "@arf-os/contracts";
import type { Bar } from "@arf-os/pine";
import { evaluateSeries, parseExpression, type SeriesValue } from "../expression/index.js";
import type { BacktestTrade } from "../types.js";

export interface SimulateResult {
  trades: BacktestTrade[];
  warnings: string[];
}

type Direction = "LONG" | "SHORT";

interface OpenPosition {
  direction: Direction;
  entryIndex: number;
  entryTime: string;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  /** `undefined` means "no target" — `risk.takeProfit.type === "none"`, exit is stop-only. */
  targetPrice: number | undefined;
  entryCommission: number;
  entryReason: string;
}

type PendingAction = { kind: "ENTER" | "REVERSE"; direction: Direction; reason: string };

function resolveParams(definition: StrategyDefinition): Record<string, number | boolean | string> {
  const params: Record<string, number | boolean | string> = {};
  for (const parameter of definition.parameters) {
    params[parameter.key] = parameter.default;
  }
  return params;
}

function requireNumericParam(
  params: Record<string, number | boolean | string>,
  key: string | undefined,
  context: string,
): number {
  if (key === undefined) {
    throw new Error(`${context}: no parameter key configured — compile() should have rejected this.`);
  }
  const value = params[key];
  if (typeof value !== "number") {
    throw new Error(`${context}: parameter "${key}" does not resolve to a numeric value.`);
  }
  return value;
}

function computeCommission(costModel: BacktestPlan["costModel"], notional: number, quantity: number): number {
  switch (costModel.commissionType) {
    case "percent":
      return notional * (costModel.commissionValue / 100);
    case "cash_per_order":
      return costModel.commissionValue;
    case "cash_per_contract":
      return costModel.commissionValue * quantity;
  }
}

function computeQuantity(definition: StrategyDefinition, equity: number, entryPrice: number): number {
  switch (definition.risk.sizingModel) {
    case "percent_of_equity":
      return (equity * (definition.risk.sizePercent / 100)) / entryPrice;
    case "fixed":
      // `risk.sizePercent` doubles as a fixed unit count in this sizing model.
      return definition.risk.sizePercent;
    case "cash":
      // `risk.sizePercent` doubles as a fixed cash amount in this sizing model.
      return definition.risk.sizePercent / entryPrice;
  }
}

function isTrue(value: SeriesValue): value is true {
  return value === true;
}

/**
 * Bar-by-bar simulation over one strategy definition and one dataset
 * window. Pure — no I/O, no DB — so it is independently testable against
 * hand-calculated fixtures (CLAUDE.md 21.1).
 *
 * Entries are confirmed-bar (evaluated on a bar's close) and fill on the
 * *next* bar's open (CLAUDE.md 12.1). Exits are the SDL's one stop / one
 * target, filled at the exact stop/target price the moment a bar's
 * high/low touches it — a limit-fill assumption (CLAUDE.md 12.3) rather
 * than a same-bar-open or worst-case-slippage fill. If both the stop and
 * the target would trigger on the same bar, the stop is assumed to fill
 * first (the conservative assumption).
 *
 * Callers must have already validated `definition` via
 * {@link LocalPineRunner.compile} — this function assumes valid,
 * supported expressions and risk configuration, and throws if that
 * invariant was skipped.
 */
export function simulate(bars: readonly Bar[], definition: StrategyDefinition, plan: BacktestPlan): SimulateResult {
  const params = resolveParams(definition);
  const longEntryAst = parseExpression(definition.signals.longEntry);
  const shortEntryAst = parseExpression(definition.signals.shortEntry);
  const longSeries = evaluateSeries(longEntryAst, { bars, params });
  const shortSeries = evaluateSeries(shortEntryAst, { bars, params });

  const warmupBars = definition.segments.warmupBars;
  const directions = new Set(definition.strategy.directions);

  // Only precomputed when the stop actually needs it — `ta.atr` reads the
  // whole bar range once, up front, rather than being recomputed per entry.
  // Built as a tiny synthetic AST rather than duplicating the evaluator's
  // ATR math here, so there is exactly one implementation of `ta.atr`.
  const stopLoss = definition.risk.stopLoss;
  const atrSeries =
    stopLoss.type === "atr_multiple"
      ? evaluateSeries(
          {
            kind: "Call",
            callee: "ta.atr",
            args: [{ kind: "Number", value: requireNumericParam(params, stopLoss.atrLengthParameter, "risk.stopLoss.atrLengthParameter") }],
          },
          { bars, params },
        )
      : undefined;

  const trades: BacktestTrade[] = [];
  const warnings: string[] = [];
  let sequenceNumber = 0;
  let equity = Number(plan.initialCapital);
  let position: OpenPosition | null = null;
  let pending: PendingAction | null = null;

  /** `undefined` means the stop can't be priced yet — e.g. `ta.atr` still inside its own warmup window. */
  function computeStopPrice(direction: Direction, entryPrice: number, entryIndex: number): number | undefined {
    if (stopLoss.type === "fixed_percent") {
      const pct = requireNumericParam(params, stopLoss.valueParameter, "risk.stopLoss");
      return direction === "LONG" ? entryPrice * (1 - pct / 100) : entryPrice * (1 + pct / 100);
    }
    // atr_multiple — compile() only admits fixed_percent and atr_multiple here.
    const multiple = requireNumericParam(params, stopLoss.valueParameter, "risk.stopLoss");
    const atrValue = atrSeries?.[entryIndex];
    if (typeof atrValue !== "number") return undefined;
    const distance = multiple * atrValue;
    return direction === "LONG" ? entryPrice - distance : entryPrice + distance;
  }

  function computeTargetPrice(direction: Direction, entryPrice: number): number | undefined {
    const takeProfit = definition.risk.takeProfit;
    if (takeProfit.type === "none") return undefined;
    // fixed_percent — compile() only admits fixed_percent and none here.
    const pct = requireNumericParam(params, takeProfit.valueParameter, "risk.takeProfit");
    return direction === "LONG" ? entryPrice * (1 + pct / 100) : entryPrice * (1 - pct / 100);
  }

  /** `undefined` means the position could not be sized yet (see {@link computeStopPrice}) — no entry happens this bar. */
  function createPosition(bar: Bar, index: number, direction: Direction, reason: string): OpenPosition | undefined {
    const entryPrice = bar.open;
    const stopPrice = computeStopPrice(direction, entryPrice, index);
    if (stopPrice === undefined) return undefined;
    const targetPrice = computeTargetPrice(direction, entryPrice);
    const quantity = computeQuantity(definition, equity, entryPrice);
    const entryCommission = computeCommission(plan.costModel, entryPrice * quantity, quantity);
    return {
      direction,
      entryIndex: index,
      entryTime: bar.time,
      entryPrice,
      quantity,
      stopPrice,
      targetPrice,
      entryCommission,
      entryReason: reason,
    };
  }

  function closePosition(open: OpenPosition, exitPrice: number, exitTime: string, exitReason: string): void {
    const exitCommission = computeCommission(plan.costModel, exitPrice * open.quantity, open.quantity);
    const fees = open.entryCommission + exitCommission;
    const grossPnl =
      open.direction === "LONG"
        ? (exitPrice - open.entryPrice) * open.quantity
        : (open.entryPrice - exitPrice) * open.quantity;
    const netPnl = grossPnl - fees;
    equity += netPnl;

    sequenceNumber += 1;
    trades.push({
      sequenceNumber,
      direction: open.direction,
      entryTime: open.entryTime,
      entryPrice: open.entryPrice,
      exitTime,
      exitPrice,
      quantity: open.quantity,
      grossPnl,
      fees,
      netPnl,
      entryReason: open.entryReason,
      exitReason,
      isOpen: false,
    });
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar === undefined) continue;

    if (pending !== null) {
      if (pending.kind === "REVERSE" && position !== null) {
        closePosition(position, bar.open, bar.time, "reversal");
        position = null;
      }
      if (position === null) {
        const created = createPosition(bar, i, pending.direction, pending.reason);
        if (created === undefined) {
          warnings.push(
            `Skipped ${pending.direction} entry at ${bar.time}: stop level not yet computable (e.g. ta.atr still warming up).`,
          );
        } else {
          position = created;
        }
      }
      pending = null;
    }

    if (position !== null) {
      const open = position;
      const hitStop = open.direction === "LONG" ? bar.low <= open.stopPrice : bar.high >= open.stopPrice;
      const hitTarget =
        open.targetPrice !== undefined &&
        (open.direction === "LONG" ? bar.high >= open.targetPrice : bar.low <= open.targetPrice);
      if (hitStop) {
        closePosition(open, open.stopPrice, bar.time, "stop_loss");
        position = null;
      } else if (hitTarget && open.targetPrice !== undefined) {
        closePosition(open, open.targetPrice, bar.time, "take_profit");
        position = null;
      }
    }

    if (i < warmupBars) continue;

    const longSignal = isTrue(longSeries[i]) && directions.has("long");
    const shortSignal = isTrue(shortSeries[i]) && directions.has("short");

    if (position === null) {
      if (longSignal) pending = { kind: "ENTER", direction: "LONG", reason: "signal:longEntry" };
      else if (shortSignal) pending = { kind: "ENTER", direction: "SHORT", reason: "signal:shortEntry" };
    } else if (definition.execution.allowReversal) {
      if (position.direction === "LONG" && shortSignal) {
        pending = { kind: "REVERSE", direction: "SHORT", reason: "signal:shortEntry" };
      } else if (position.direction === "SHORT" && longSignal) {
        pending = { kind: "REVERSE", direction: "LONG", reason: "signal:longEntry" };
      }
    }
  }

  if (position !== null) {
    const open: OpenPosition = position;
    warnings.push(`Position still open at end of data (entered ${open.entryTime}).`);
    sequenceNumber += 1;
    trades.push({
      sequenceNumber,
      direction: open.direction,
      entryTime: open.entryTime,
      entryPrice: open.entryPrice,
      quantity: open.quantity,
      fees: open.entryCommission,
      entryReason: open.entryReason,
      isOpen: true,
    });
  }

  return { trades, warnings };
}
