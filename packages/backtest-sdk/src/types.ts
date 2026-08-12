import type { BacktestPlan, StrategyDefinition } from "@arf-os/contracts";
import type { Bar } from "@arf-os/pine";

export type { Bar };

/**
 * What this runner supports, stated explicitly so an unsupported
 * `StrategyDefinition` fails at {@link BacktestRunner.compile} with a clear
 * diagnostic instead of silently producing a wrong result (CLAUDE.md 12.2,
 * 13). Every field here is a real constraint of the current engine, not
 * aspirational.
 */
export interface RunnerCapabilities {
  runnerName: string;
  runnerVersion: string;
  supportedEntryOrders: readonly StrategyDefinition["execution"]["entryOrder"][];
  supportedStopLossTypes: readonly StrategyDefinition["risk"]["stopLoss"]["type"][];
  supportedTakeProfitTypes: readonly StrategyDefinition["risk"]["takeProfit"]["type"][];
  /** `ta.`-prefixed function names the expression evaluator recognises. */
  supportedExpressionFunctions: readonly string[];
  supportsSessionFilter: boolean;
  supportsMultiTimeframe: boolean;
  /** Whether `costs.slippageTicks > 0` can be honoured (v1: no tick-size source, so no). */
  supportsNonZeroTickSlippage: boolean;
  /** Whether Pine's `var`/`:=` persistent (bar-to-bar stateful) variables are supported — e.g. a ratcheting trailing stop or a drawdown halt that never resets. */
  supportsPersistentState: boolean;
}

export interface CompileInput {
  definition: StrategyDefinition;
}

export interface CompileSuccess {
  ok: true;
  warnings: string[];
}

export interface CompileFailure {
  ok: false;
  errors: string[];
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface BacktestInput {
  /** Identifies this specific run so a later {@link BacktestRunner.cancel} call can find it. */
  runId: string;
  definition: StrategyDefinition;
  plan: BacktestPlan;
  bars: Bar[];
}

export interface BacktestTrade {
  sequenceNumber: number;
  direction: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  exitTime?: string | undefined;
  exitPrice?: number | undefined;
  quantity: number;
  grossPnl?: number | undefined;
  fees: number;
  netPnl?: number | undefined;
  entryReason: string;
  exitReason?: string | undefined;
  isOpen: boolean;
}

export interface BacktestSuccess {
  ok: true;
  runnerName: string;
  runnerVersion: string;
  trades: BacktestTrade[];
  warnings: string[];
  startedAt: string;
  completedAt: string;
}

export interface BacktestFailure {
  ok: false;
  errorCode: string;
  message: string;
}

export type BacktestResult = BacktestSuccess | BacktestFailure;

/**
 * The local runner contract (CLAUDE.md 13). A worker calls `compile()` then
 * `run()`; `cancel()` is best-effort cooperative cancellation, not a
 * guarantee of immediate stop.
 */
export interface BacktestRunner {
  capabilities(): RunnerCapabilities;
  compile(input: CompileInput): Promise<CompileResult>;
  run(input: BacktestInput): Promise<BacktestResult>;
  cancel(runId: string): Promise<void>;
}
