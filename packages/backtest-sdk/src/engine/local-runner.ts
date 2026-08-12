import type { StrategyDefinition } from "@arf-os/contracts";
import { ExpressionSyntaxError, parseExpression, validateExpression } from "../expression/index.js";
import type {
  BacktestInput,
  BacktestResult,
  BacktestRunner,
  CompileInput,
  CompileResult,
  RunnerCapabilities,
} from "../types.js";
import { simulate } from "./simulate.js";

export const LOCAL_PINE_RUNNER_NAME = "arf-os-local-pine-runner";
export const LOCAL_PINE_RUNNER_VERSION = "0.1.0";

const CAPABILITIES: RunnerCapabilities = {
  runnerName: LOCAL_PINE_RUNNER_NAME,
  runnerVersion: LOCAL_PINE_RUNNER_VERSION,
  supportedEntryOrders: ["market_next_bar"],
  // `risk_multiple` and `fixed_ticks` remain unsupported — no R-multiple
  // baseline and no tick-size source exist anywhere in the SDL or
  // BacktestPlan this engine could compute or interpret them against.
  // `atr_multiple` computes a one-time stop distance at entry from
  // `ta.atr` — it does NOT ratchet/trail; a strategy whose real behavior
  // depends on a trailing stop will run differently here than as written.
  supportedStopLossTypes: ["fixed_percent", "atr_multiple"],
  // "none" means stop-only, no fixed target.
  supportedTakeProfitTypes: ["fixed_percent", "none"],
  supportedExpressionFunctions: [
    "ta.sma",
    "ta.ema",
    "ta.rsi",
    "ta.crossover",
    "ta.crossunder",
    "ta.highest",
    "ta.lowest",
    "ta.atr",
  ],
  supportsSessionFilter: false,
  supportsMultiTimeframe: false,
  // No tick-size source exists anywhere in the SDL or BacktestPlan, so a
  // nonzero `costs.slippageTicks` can't be translated into a price offset.
  supportsNonZeroTickSlippage: false,
  // The expression evaluator is stateless — every value is a pure function
  // of the current + historical bars, recomputed fresh each time. Pine's
  // `var`/`:=` persistent variables (e.g. a ratcheting trailing stop, a
  // drawdown circuit-breaker flag that never resets) have no equivalent
  // here and never will without a materially larger interpreter.
  supportsPersistentState: false,
};

function collectParamKeys(definition: StrategyDefinition): Set<string> {
  return new Set(definition.parameters.map((p) => p.key));
}

/** The SDL contract only guarantees `atrLengthParameter`/`valueParameter` are non-empty strings — this confirms they actually name a declared numeric parameter. */
function parameterIsNumeric(definition: StrategyDefinition, key: string | undefined): boolean {
  if (key === undefined) return false;
  const parameter = definition.parameters.find((p) => p.key === key);
  return parameter !== undefined && typeof parameter.default === "number";
}

function validateSignalExpressions(definition: StrategyDefinition, knownParamKeys: Set<string>): string[] {
  const errors: string[] = [];
  for (const [field, source] of [
    ["signals.longEntry", definition.signals.longEntry],
    ["signals.shortEntry", definition.signals.shortEntry],
  ] as const) {
    try {
      const ast = parseExpression(source);
      errors.push(...validateExpression(ast, knownParamKeys).map((e) => `${field}: ${e}`));
    } catch (error) {
      const message = error instanceof ExpressionSyntaxError ? error.message : String(error);
      errors.push(`${field}: ${message}`);
    }
  }
  return errors;
}

function validateAgainstCapabilities(definition: StrategyDefinition): string[] {
  const errors: string[] = [];

  if (!CAPABILITIES.supportedEntryOrders.includes(definition.execution.entryOrder)) {
    errors.push(
      `execution.entryOrder "${definition.execution.entryOrder}" is not supported. Supported: ${CAPABILITIES.supportedEntryOrders.join(", ")}.`,
    );
  }
  if (!CAPABILITIES.supportedStopLossTypes.includes(definition.risk.stopLoss.type)) {
    errors.push(
      `risk.stopLoss.type "${definition.risk.stopLoss.type}" is not supported. Supported: ${CAPABILITIES.supportedStopLossTypes.join(", ")}.`,
    );
  } else if (definition.risk.stopLoss.type === "atr_multiple") {
    if (!parameterIsNumeric(definition, definition.risk.stopLoss.atrLengthParameter)) {
      errors.push(
        `risk.stopLoss.atrLengthParameter "${definition.risk.stopLoss.atrLengthParameter ?? ""}" does not name a declared numeric parameter.`,
      );
    }
    if (!parameterIsNumeric(definition, definition.risk.stopLoss.valueParameter)) {
      errors.push(
        `risk.stopLoss.valueParameter "${definition.risk.stopLoss.valueParameter ?? ""}" does not name a declared numeric parameter.`,
      );
    }
  }
  if (!CAPABILITIES.supportedTakeProfitTypes.includes(definition.risk.takeProfit.type)) {
    errors.push(
      `risk.takeProfit.type "${definition.risk.takeProfit.type}" is not supported. Supported: ${CAPABILITIES.supportedTakeProfitTypes.join(", ")}.`,
    );
  }
  if (!CAPABILITIES.supportsSessionFilter && definition.market.session !== "24x7") {
    errors.push(
      `market.session "${definition.market.session}" requires session filtering, which this runner does not implement — only "24x7" is accepted.`,
    );
  }
  if (!CAPABILITIES.supportsNonZeroTickSlippage && definition.costs.slippageTicks !== 0) {
    errors.push("costs.slippageTicks must be 0 — this runner has no tick-size source to apply slippage against.");
  }

  return errors;
}

async function compile(input: CompileInput): Promise<CompileResult> {
  const knownParamKeys = collectParamKeys(input.definition);
  const errors = [
    ...validateSignalExpressions(input.definition, knownParamKeys),
    ...validateAgainstCapabilities(input.definition),
  ];

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, warnings: [] };
}

const cancelledRunIds = new Set<string>();

async function run(input: BacktestInput): Promise<BacktestResult> {
  if (cancelledRunIds.has(input.runId)) {
    cancelledRunIds.delete(input.runId);
    return { ok: false, errorCode: "CANCELLED", message: `Run ${input.runId} was cancelled before it started.` };
  }

  const startedAt = new Date().toISOString();
  try {
    const { trades, warnings } = simulate(input.bars, input.definition, input.plan);
    return {
      ok: true,
      runnerName: LOCAL_PINE_RUNNER_NAME,
      runnerVersion: LOCAL_PINE_RUNNER_VERSION,
      trades,
      warnings,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "SIMULATION_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Best-effort cooperative cancellation: since `simulate()` is a small
 * synchronous pass over an in-memory bar array (not a long-running
 * external process), there is nothing to interrupt mid-flight. Calling
 * `cancel()` before `run()` starts for the same `runId` prevents it from
 * starting; calling it during or after `run()` has no effect.
 */
async function cancel(runId: string): Promise<void> {
  cancelledRunIds.add(runId);
}

export function createLocalPineRunner(): BacktestRunner {
  return {
    capabilities: () => CAPABILITIES,
    compile,
    run,
    cancel,
  };
}
