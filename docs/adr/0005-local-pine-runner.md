# ADR 0005: Local runner executes SDL signal expressions directly, not generated Pine source

## Status

Accepted — 2026-08-10. First vertical slice implemented in `packages/backtest-sdk`.

## Context

README's status table listed "Local Pine runner (`backtest-sdk`)" as **Not
started**, and `POST /v1/backtest-runs` already accepted
`runnerType: "LOCAL_RUNNER"` without anything ever executing it. CLAUDE.md 13
specifies the `BacktestRunner` interface (`capabilities()`, `compile()`,
`run()`, `cancel()`) but leaves the runner's internal design open, and ADR
0004 explicitly deferred it: "a local engine's broker emulation differs from
TradingView's... without a parity check, every downstream number inherits an
unvalidated assumption."

A general Pine v6 interpreter — parsing arbitrary generated Pine source,
covering the full language — is its own multi-phase effort on top of work
that does not yet exist in this repository: there is no Pine source
generator (`pine/boilerplate`, `pine/libraries`, `pine/generated` are all
empty), and no OHLCV/dataset storage existed anywhere in the schema before
this change. Building a full interpreter first would mean building ahead of
what is needed (CLAUDE.md 3.8's spirit applied to the runner, not just
browser automation) and risks shipping something that looks complete but
whose broker-emulation gaps are undiscoverable until a real parity failure.

## Decision

The local runner executes the SDL's `signals.longEntry` / `signals.shortEntry`
expressions directly — evaluating the same opaque Pine boolean-expression
strings the Strategy Architect hands the Pine Engineer (`strategy-definition.ts`)
— rather than parsing or generating full Pine v6 source.

1. `packages/backtest-sdk/src/expression` is a small, real recursive-descent
   parser and evaluator for a deliberately constrained grammar: OHLCV
   identifiers, SDL parameter references, comparisons, `and`/`or`/`not`,
   arithmetic, and five `ta.*` functions (`sma`, `ema`, `rsi`, `crossover`,
   `crossunder`). Every expression is evaluated as a full per-bar series, the
   same way Pine itself evaluates bar by bar.
2. `RunnerCapabilities` states exactly what is and is not supported —
   `market_next_bar` entries only, no session filtering, no nonzero tick
   slippage (there is no tick-size source anywhere in the SDL or
   `BacktestPlan` to apply it against) — and `compile()` rejects anything
   outside that list with a specific error rather than silently evaluating
   to an empty or wrong signal. (Supported stop/target types expanded in the
   2026-08-12 extension below.)
3. `dataset_versions` (new table) plus the existing `artefacts` table hold a
   versioned, checksummed OHLCV bar series. There is no public
   ingestion/upload API yet — this slice seeds one golden fixture directly;
   real ingestion is separate future scope.
4. The worker (`apps/worker-backtest`) writes the resulting trade ledger and
   emits the *same* `trades.normalised` event `report_upload`-driven
   TradingView ingestion already emits. Equity reconstruction, metrics, and
   parity are completely unmodified by this change — they cannot tell the
   difference between a local-runner trade and a TradingView one.

## Alternatives

- **Parse and execute generated Pine v6 source.** The "correct" long-term
  shape, but requires a Pine source generator that does not exist yet
  (`packages/pine`'s definition-to-source mapping, CLAUDE.md 12.4) and a much
  larger language surface. Deferred, not rejected — this ADR's runner
  interface (`BacktestRunner`) does not change if a future runner executes
  generated source instead of SDL expressions directly.
- **Shell out to an existing open-source Pine-compatible engine.** Rejected:
  no vetted option was identified, and CLAUDE.md 3.8's caution against
  fragile external dependencies for the platform's core evidence path
  applies here by the same reasoning it applies to browser automation.
- **Wait for full dataset ingestion before building any runner.** Rejected as
  the wrong ordering — the runner's actual execution semantics (confirmed-bar
  signals, next-bar fills, stop/target fills, commission) are the part most
  likely to hide bugs, and are exactly what a hand-calculated golden fixture
  can prove correct without needing a real ingestion pipeline.

## Consequences

- A `StrategyDefinition` using an unsupported feature (a `stop`/`limit` entry
  order, a `risk_multiple`/`fixed_ticks` stop, a non-`"24x7"` session,
  nonzero `slippageTicks`, a signal expression using persistent state) fails
  at `compile()` with a specific diagnostic. It never silently runs with
  that feature ignored.
- The golden fixture (`pine/fixtures/ohlcv/golden-crossover.csv`) is hand
  calculated end to end — entry price, fill bar, stop/target level, exit
  price, commission, net P&L — and asserted exactly in
  `packages/backtest-sdk/src/engine/simulate.test.ts`, matching CLAUDE.md
  21.1's "tests against hand-calculated fixtures."
- TradingView remains the mandatory parity and acceptance environment (ADR
  0004, unchanged). A `LOCAL_RUNNER` run existing does not itself justify any
  promotion; `parity_reports` still requires a real TradingView verification
  to compare against.
- `cancel()` is best-effort only: since `run()` is a small synchronous pass
  over an in-memory bar array, there is nothing to interrupt mid-flight.
  Calling `cancel()` before a run starts prevents it; calling it during or
  after has no effect. This is honest for the current fixture-scale usage
  and would need real interruption if runs grow much larger.

## Extension — 2026-08-12: `ta.highest`/`ta.lowest`/`ta.atr`, `[n]` offset, ATR-multiple stop, stop-only exits

Forking a real public strategy (a Donchian-channel breakout with an ATR
trailing stop) surfaced that the original five-function grammar couldn't
express even the *entry* of a common, ordinary strategy shape. This
extension stays entirely within the original decision's boundary — the
evaluator is still 100% stateless, still not a Pine parser — and adds:

- **`ta.highest(source, length)` / `ta.lowest(source, length)`** — rolling
  window extrema, same shape as the existing `ta.sma`.
- **`ta.atr(length)`** — the one function with a fixed signature (no
  `source` argument; Pine's own `ta.atr` is implicitly OHLC-based), computed
  via Wilder's RMA (alpha = 1/length), not a plain moving average — a real
  distinction, since this engine already had a "simplified, not Wilder"
  disclaimer on `ta.rsi` and this is the function where getting that wrong
  would actually matter (it drives stop distance).
- **`expr[n]`** — Pine's historical-offset operator. Without it, an entry
  condition referencing "the channel as of one bar ago" would either be
  unwritable or would silently read the current bar's own high into its own
  breakout level — the exact lookahead CLAUDE.md 12.2 treats as a hard
  error. This was the more important half of "faithful entries": the
  functions alone weren't sufficient without offset support.
- **`risk.stopLoss.type = "atr_multiple"`** — a stop distance computed
  **once, at entry**, from `atrMultiple * ta.atr(atrLength)` at the entry
  bar. `RiskLevel` gained an `atrLengthParameter` field (the SDL contract
  change) since the ATR period and the multiple are two different numbers.
- **`risk.takeProfit.type = "none"`** — a real gap: the schema previously
  forced every strategy to declare both a stop and a target, but plenty of
  real strategies (this Donchian one included) are stop-only.

**Explicit non-goal, kept out on purpose: persistent/stateful variables.**
The Donchian strategy's actual exit is a *ratcheting* trailing stop —
Pine's `var float longTrail` pattern, monotonically tightening bar to bar —
plus a drawdown circuit-breaker flag that, once tripped, never resets. Both
require the interpreter to remember values across bars; this evaluator
recomputes every series fresh from the bar array every time and has no
concept of "the value I computed last bar." Adding that is not "one more
function" — it is a different kind of interpreter (assignment, evaluation
order, mutable state), and would be the point at which this stops being "a
constrained expression evaluator" and starts being "a Pine interpreter,"
which this ADR's Alternatives section already declined to build. The forked
Donchian strategy therefore runs here with a **one-time** ATR stop and no
target — not its real exit — and `RunnerCapabilities.supportsPersistentState
= false` says so explicitly rather than silently producing a result that
looks like the real strategy's backtest.

## Security implications

None new. The runner performs no network access, no code execution beyond
its own constrained expression grammar (never `eval`, never arbitrary code),
and reads only organisation-owned datasets (`dataset_versions`/`artefacts`
are organisation-scoped, and `POST /v1/backtest-runs` verifies dataset
ownership before accepting a `datasetVersionId`, mirroring
`verificationMatchesVersion`'s existing pattern).

## Migration / rollback

Purely additive. `TRADINGVIEW` runs and the entire ingestion/parity path are
untouched — `LOCAL_RUNNER` is a second, opt-in value of an enum that already
existed on `backtest_runs.runner_type`. Rolling back means simply not
enqueuing `backtest_run.local_execution_requested` events; no data migration
is required to remove the feature, and `dataset_versions`/the new
`backtest_runs.dataset_version_id` column can stay unused without effect.
