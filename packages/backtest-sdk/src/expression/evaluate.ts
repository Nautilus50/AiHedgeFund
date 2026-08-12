import type { Bar } from "@arf-os/pine";
import type { BinaryOperator, ExpressionNode } from "./ast.js";

export type SeriesValue = number | boolean | undefined;

export interface EvalContext {
  bars: readonly Bar[];
  /** SDL parameter values, resolved (e.g. from `parameters[].default`) before evaluation. */
  params: Readonly<Record<string, number | boolean | string>>;
}

const OHLCV_FIELDS = ["open", "high", "low", "close", "volume"] as const;
type OhlcvField = (typeof OHLCV_FIELDS)[number];

function isOhlcvField(name: string): name is OhlcvField {
  return (OHLCV_FIELDS as readonly string[]).includes(name);
}

interface FunctionSpec {
  argCount: number;
}

/** The complete set of `ta.*` functions this evaluator understands (also surfaced via `RunnerCapabilities`). */
export const SUPPORTED_FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  "ta.sma": { argCount: 2 },
  "ta.ema": { argCount: 2 },
  "ta.rsi": { argCount: 2 },
  "ta.crossover": { argCount: 2 },
  "ta.crossunder": { argCount: 2 },
  "ta.highest": { argCount: 2 },
  "ta.lowest": { argCount: 2 },
  /** No `source` argument — Pine's `ta.atr(length)` is fixed to the bar's own high/low/close. */
  "ta.atr": { argCount: 1 },
};

/**
 * Validates an expression against the evaluator's grammar and the SDL's
 * known parameter keys, without touching any bar data. Called at
 * `compile()` time so an unsupported expression fails with a clear
 * diagnostic instead of silently evaluating to `undefined` everywhere
 * (CLAUDE.md 12.2).
 */
export function validateExpression(node: ExpressionNode, knownParamKeys: ReadonlySet<string>): string[] {
  switch (node.kind) {
    case "Number":
    case "Bool":
      return [];
    case "Identifier":
      if (isOhlcvField(node.name) || knownParamKeys.has(node.name)) {
        return [];
      }
      return [`Unknown identifier "${node.name}" (not an OHLCV field or a declared parameter).`];
    case "Unary":
      return validateExpression(node.operand, knownParamKeys);
    case "Offset":
      return validateExpression(node.expr, knownParamKeys);
    case "Binary":
      return [...validateExpression(node.left, knownParamKeys), ...validateExpression(node.right, knownParamKeys)];
    case "Call": {
      const spec = SUPPORTED_FUNCTIONS[node.callee];
      if (spec === undefined) {
        return [`Unsupported function "${node.callee}". Supported: ${Object.keys(SUPPORTED_FUNCTIONS).join(", ")}.`];
      }
      const errors: string[] = [];
      if (node.args.length !== spec.argCount) {
        errors.push(`"${node.callee}" expects ${spec.argCount} argument(s), got ${node.args.length}.`);
      }
      for (const arg of node.args) {
        errors.push(...validateExpression(arg, knownParamKeys));
      }
      return errors;
    }
  }
}

function windowedAverage(source: readonly SeriesValue[], length: number): SeriesValue[] {
  const result: SeriesValue[] = new Array<SeriesValue>(source.length).fill(undefined);
  for (let i = length - 1; i < source.length; i++) {
    let sum = 0;
    let valid = true;
    for (let k = i - length + 1; k <= i; k++) {
      const value = source[k];
      if (typeof value !== "number") {
        valid = false;
        break;
      }
      sum += value;
    }
    if (valid) result[i] = sum / length;
  }
  return result;
}

/** Seeded with the SMA of the first `length` values, then exponentially smoothed with the given `smoothing` (alpha). */
function smoothedAverage(source: readonly SeriesValue[], length: number, smoothing: number): SeriesValue[] {
  const result: SeriesValue[] = new Array<SeriesValue>(source.length).fill(undefined);
  const seedSeries = windowedAverage(source, length);
  let previous: number | undefined;

  for (let i = 0; i < source.length; i++) {
    if (previous === undefined) {
      const seed = seedSeries[i];
      if (typeof seed === "number") {
        result[i] = seed;
        previous = seed;
      }
      continue;
    }
    const value = source[i];
    if (typeof value !== "number") continue;
    const next = value * smoothing + previous * (1 - smoothing);
    result[i] = next;
    previous = next;
  }
  return result;
}

/** Standard exponential smoothing, alpha = 2/(length+1). */
function exponentialAverage(source: readonly SeriesValue[], length: number): SeriesValue[] {
  return smoothedAverage(source, length, 2 / (length + 1));
}

/** Wilder's RMA, alpha = 1/length — what Pine's `ta.atr` actually uses (not a plain EMA). */
function wilderAverage(source: readonly SeriesValue[], length: number): SeriesValue[] {
  return smoothedAverage(source, length, 1 / length);
}

function windowedExtreme(
  source: readonly SeriesValue[],
  length: number,
  pick: (a: number, b: number) => number,
): SeriesValue[] {
  const result: SeriesValue[] = new Array<SeriesValue>(source.length).fill(undefined);
  for (let i = length - 1; i < source.length; i++) {
    let extreme: number | undefined;
    let valid = true;
    for (let k = i - length + 1; k <= i; k++) {
      const value = source[k];
      if (typeof value !== "number") {
        valid = false;
        break;
      }
      extreme = extreme === undefined ? value : pick(extreme, value);
    }
    if (valid && extreme !== undefined) result[i] = extreme;
  }
  return result;
}

/** True Range per bar: for the first bar (no previous close), just high − low, matching Pine's own behaviour. */
function trueRangeSeries(bars: readonly Bar[]): SeriesValue[] {
  return bars.map((bar, i) => {
    const previous = i > 0 ? bars[i - 1] : undefined;
    if (previous === undefined) return bar.high - bar.low;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
  });
}

/** Pine's `expr[n]` — shifts a series forward so `result[i] = source[i - n]`. */
function shiftSeries(source: readonly SeriesValue[], offset: number): SeriesValue[] {
  if (offset === 0) return source.slice();
  const result: SeriesValue[] = new Array<SeriesValue>(source.length).fill(undefined);
  for (let i = offset; i < source.length; i++) {
    result[i] = source[i - offset];
  }
  return result;
}

/** Simplified RSI (plain rolling average of gains/losses, not Wilder smoothing) — not used by the golden fixture. */
function relativeStrengthIndex(source: readonly SeriesValue[], length: number): SeriesValue[] {
  const result: SeriesValue[] = new Array<SeriesValue>(source.length).fill(undefined);
  for (let i = length; i < source.length; i++) {
    let gainSum = 0;
    let lossSum = 0;
    let valid = true;
    for (let k = i - length + 1; k <= i; k++) {
      const cur = source[k];
      const prev = source[k - 1];
      if (typeof cur !== "number" || typeof prev !== "number") {
        valid = false;
        break;
      }
      const diff = cur - prev;
      if (diff >= 0) gainSum += diff;
      else lossSum += -diff;
    }
    if (!valid) continue;
    const avgGain = gainSum / length;
    const avgLoss = lossSum / length;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function crossSeries(a: readonly SeriesValue[], b: readonly SeriesValue[], direction: "over" | "under"): SeriesValue[] {
  const result: SeriesValue[] = new Array<SeriesValue>(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    const aPrev = a[i - 1];
    const bPrev = b[i - 1];
    const aCur = a[i];
    const bCur = b[i];
    if (typeof aPrev !== "number" || typeof bPrev !== "number" || typeof aCur !== "number" || typeof bCur !== "number") {
      continue;
    }
    result[i] =
      direction === "over" ? aPrev <= bPrev && aCur > bCur : aPrev >= bPrev && aCur < bCur;
  }
  return result;
}

/** Extracts a single constant number from a series (a length/period argument must not vary bar to bar). */
function constantNumber(series: readonly SeriesValue[]): number | undefined {
  const found = series.find((v) => typeof v === "number");
  return typeof found === "number" ? found : undefined;
}

function combineBinary(operator: BinaryOperator, left: SeriesValue, right: SeriesValue): SeriesValue {
  switch (operator) {
    case "and": {
      const l = typeof left === "boolean" ? left : undefined;
      const r = typeof right === "boolean" ? right : undefined;
      if (l === false || r === false) return false;
      if (l === undefined || r === undefined) return undefined;
      return l && r;
    }
    case "or": {
      const l = typeof left === "boolean" ? left : undefined;
      const r = typeof right === "boolean" ? right : undefined;
      if (l === true || r === true) return true;
      if (l === undefined || r === undefined) return undefined;
      return l || r;
    }
    case "+":
    case "-":
    case "*":
    case "/": {
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      if (operator === "+") return left + right;
      if (operator === "-") return left - right;
      if (operator === "*") return left * right;
      return right === 0 ? undefined : left / right;
    }
    case ">":
    case "<":
    case ">=":
    case "<=":
    case "==":
    case "!=": {
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      if (operator === ">") return left > right;
      if (operator === "<") return left < right;
      if (operator === ">=") return left >= right;
      if (operator === "<=") return left <= right;
      if (operator === "==") return left === right;
      return left !== right;
    }
  }
}

/**
 * Evaluates an expression across the entire bar range at once, one value
 * per bar. Every value the SDL's Pine text can reference is treated as a
 * series, matching how Pine itself evaluates expressions bar by bar
 * (CLAUDE.md 12.1's "confirmed-bar logic"). `undefined` means "not yet
 * computable" (e.g. an SMA before its warmup window is full).
 */
export function evaluateSeries(node: ExpressionNode, ctx: EvalContext): SeriesValue[] {
  switch (node.kind) {
    case "Number":
      return new Array<SeriesValue>(ctx.bars.length).fill(node.value);
    case "Bool":
      return new Array<SeriesValue>(ctx.bars.length).fill(node.value);
    case "Identifier": {
      if (isOhlcvField(node.name)) {
        return ctx.bars.map((bar) => bar[node.name as OhlcvField]);
      }
      const paramValue = ctx.params[node.name];
      if (typeof paramValue === "number" || typeof paramValue === "boolean") {
        return new Array<SeriesValue>(ctx.bars.length).fill(paramValue);
      }
      return new Array<SeriesValue>(ctx.bars.length).fill(undefined);
    }
    case "Unary": {
      const operand = evaluateSeries(node.operand, ctx);
      return operand.map((v) => {
        if (node.operator === "not") return typeof v === "boolean" ? !v : undefined;
        return typeof v === "number" ? -v : undefined;
      });
    }
    case "Binary": {
      const left = evaluateSeries(node.left, ctx);
      const right = evaluateSeries(node.right, ctx);
      return left.map((l, i) => combineBinary(node.operator, l, right[i]));
    }
    case "Offset":
      return shiftSeries(evaluateSeries(node.expr, ctx), node.offset);
    case "Call": {
      const spec = SUPPORTED_FUNCTIONS[node.callee];
      if (spec === undefined) {
        throw new Error(`evaluateSeries called with unsupported function "${node.callee}" — compile() should have rejected this.`);
      }

      if (node.callee === "ta.crossover" || node.callee === "ta.crossunder") {
        const [aNode, bNode] = node.args;
        if (aNode === undefined || bNode === undefined) {
          throw new Error(`"${node.callee}" requires 2 arguments — compile() should have rejected this.`);
        }
        const a = evaluateSeries(aNode, ctx);
        const b = evaluateSeries(bNode, ctx);
        return crossSeries(a, b, node.callee === "ta.crossover" ? "over" : "under");
      }

      if (node.callee === "ta.atr") {
        const [lengthNode] = node.args;
        if (lengthNode === undefined) {
          throw new Error(`"${node.callee}" requires 1 argument — compile() should have rejected this.`);
        }
        const length = constantNumber(evaluateSeries(lengthNode, ctx));
        if (length === undefined || length < 1) {
          return new Array<SeriesValue>(ctx.bars.length).fill(undefined);
        }
        return wilderAverage(trueRangeSeries(ctx.bars), Math.round(length));
      }

      const [sourceNode, lengthNode] = node.args;
      if (sourceNode === undefined || lengthNode === undefined) {
        throw new Error(`"${node.callee}" requires 2 arguments — compile() should have rejected this.`);
      }
      const source = evaluateSeries(sourceNode, ctx);
      const length = constantNumber(evaluateSeries(lengthNode, ctx));
      if (length === undefined || length < 1) {
        return new Array<SeriesValue>(ctx.bars.length).fill(undefined);
      }
      const roundedLength = Math.round(length);

      if (node.callee === "ta.sma") return windowedAverage(source, roundedLength);
      if (node.callee === "ta.ema") return exponentialAverage(source, roundedLength);
      if (node.callee === "ta.highest") return windowedExtreme(source, roundedLength, Math.max);
      if (node.callee === "ta.lowest") return windowedExtreme(source, roundedLength, Math.min);
      return relativeStrengthIndex(source, roundedLength);
    }
  }
}
