# ADR 0009: Validation Lab, first slice — evidence computable purely from existing data

## Status

Accepted — 2026-08-14. Implemented across `packages/metrics`, `apps/api`, and `apps/web`'s new
`/backtest-runs/[id]/validation` page.

## Context

AI_RESEARCH_HEDGE_FUND_SPEC.md §7.7 (Robustness Validator) lists 19 test types; §15.8
(Validation Lab UI) lists corresponding panels. Nothing in this repo implements any of them.
Most require capabilities that don't exist yet: re-running a backtest with a perturbed cost
model, parameters, or start date (parameter-neighbour stability, cost/slippage sensitivity,
entry delay, missed-trade simulation, start-date sensitivity — all need either a new
backtest-run trigger or a strategy-version-branching decision this slice doesn't make);
additional datasets (symbol transfer); a real statistical methodology this session won't
improvise (Monte Carlo path resampling, the multiple-testing penalty); or a benchmark data
source that doesn't exist. Building any of these half-right would be worse than not building
them — CLAUDE.md's own instruction is to make it easier to reject a weak strategy than to make
it look strong, and a fabricated robustness check does the opposite.

## Decision

Build the subset of §7.7's tests that are genuinely computable today, purely from
`backtest_runs`/`trades` already in Postgres for one strategy version:

1. **Segment distribution** — every run for the strategy version grouped by `(segmentKind,
   status)`. Not itself a named §7.7 test, but the thing a reader needs before trusting #2 (e.g.
   "there's only one OOS run and it's 3 trades").
2. **IS/OOS degradation** — the target run compared against every `SUCCEEDED` sibling run on the
   same strategy version, **same symbol, same timeframe**, with a complementary segment kind.
   `strategyVersions` has no symbol/timeframe column of its own, so the symbol/timeframe filter
   is required, not optional — without it a sibling on an unrelated market could silently
   corrupt the comparison. No tie-break rule: every matching sibling is returned and compared
   individually, most-recent-first, not a single invented "the" comparison.
3. **Trade-removal concentration** — the full cumulative-contribution curve (closed trades
   sorted by net P&L descending, running % of total), not a single fixed "top N." A fixed N
   would be defining the test by an arbitrary constant; the curve is the actual answer to "does
   the edge depend on a few extreme trades" (§7.7 item 15). `topN` is only a UI highlight
   (`packages/metrics/src/robustness.ts`'s `computeTradeRemovalConcentration`).
4. **Long/short directional breakdown** — `calculateCoreMetrics` run separately on long-only
   and short-only trades. Verified safe: the function re-sorts internally and never reads
   `tradeNumber`, so filtering before calling it doesn't corrupt anything it computes — except
   two fields, addressed below.

**`SubsetMetrics`** (`Omit<CoreMetrics, "longestLosingStreak" | "monthlyReturns">`) is what every
function above returns, never raw `CoreMetrics`, whenever the input is a filtered subset of a
run's trades (long-only, short-only). Both omitted fields are shaped by the trade ledger's real
interleaved order: `longestLosingStreak` counts consecutive real-time losers — a direction
filter breaks up streaks that really happened (interrupted by a trade of the other direction)
or invents ones that never did; `monthlyReturns` becomes gappy and misleading over a subset.
Presenting either as if computed over the real sequence would be a fabricated statistic, not
an honest one.

**Compute live, not persisted.** No new table, no new `metric_snapshots` scope (none of that
enum's existing scopes — `RUN|SEGMENT|STRATEGY_VERSION|SYMBOL|PARAMETER_SET|
FORWARD_DEPLOYMENT|PORTFOLIO` — fit "a robustness-test result derived from one run's trade
ledger"). The underlying data (`backtest_runs`, `trades`) is immutable and every function here
is deterministic, so a specific `(target run id, sibling run id)` pair always produces the same
numbers — the real risk isn't reproducibility of a fixed pair, it's *which* sibling gets
compared silently changing as new runs are added later. The response addresses this directly:
every payload echoes `computedAt` and the exact run ids compared, so if this is ever cited
informally before a committee decision, it's reproducible by run id, not by "whatever was OOS
when the page loaded."

**No `ROBUSTNESS_VALIDATION` workflow-state/gate integration this slice.** CLAUDE.md §10's own
canonical `workflow.transition()` example already names `"ROBUSTNESS_VALIDATION"` as a
`from` state — but it's unimplemented in `packages/contracts/src/enums.ts`'s `WorkflowState`
enum and `packages/workflow/src/policy.ts`'s `TRANSITION_RULES`, both confirmed by direct read.
Adding a real `WorkflowState` touches the state machine, every UI badge, and every place that
switches on `WorkflowState` — a materially bigger commitment than this slice takes on. This is
framed as **a smaller commitment, deferred**, not as following an established "evidence first,
gate later" precedent: `TRADINGVIEW_VERIFICATION` was in fact a `WorkflowState` from this
repo's initial scaffolding, with only its *gate* added later — that's precedent for "a gate can
lag its state," not for "evidence UI can exist with no state at all." This slice's
justification stands on its own for that reason, not on a precedent that doesn't quite hold.

### Benchmark comparison — added 2026-08-26, once real price data existed

Added after this ADR's initial acceptance. Originally listed below as unbuilt for a concrete
reason: no benchmark price source existed anywhere in this repo. ADR 0014 (real OHLCV
ingestion) closed that gap, so `getValidationLabReport` now computes a buy-and-hold comparison
over the target run's own `[fromTs, toTs]` window when the run has a linked
`datasetVersionId`: `loadDatasetBars` (`apps/api/src/services/datasets.ts`) reads that
dataset's bars back out of object storage (the read side of `createDatasetVersion`), and the
pure `resolveBenchmarkComparison` (`apps/api/src/services/validation-lab.ts`) picks the first
in-window bar's open and the last in-window bar's close as a single frictionless buy-and-hold
trade, then `computeBenchmarkComparison` (`packages/metrics/src/robustness.ts`) turns that into
`strategyReturnPct` (netProfit / initialCapital, cost-inclusive since netProfit already is),
`benchmarkReturnPct`, and their percentage-point `excessReturnPct` gap. Two honesty points
stated in both the methodology hint and here, not just implied: this compares **total return
only** — no risk adjustment, so a strategy with a lower return but a far shallower drawdown
does not read as "worse" from this number alone — and it carries a stated **asymmetry**, since
the benchmark side assumes one frictionless trade while the strategy side already nets out its
own costs. A run with no linked dataset, or a dataset whose bars don't cover the run's window,
reports `result: undefined` with a `reasonCode` (`NO_DATASET` / `NO_BARS_IN_WINDOW`) rather than
a zero or a fabricated comparison.

### Monte Carlo fan — added 2026-08-26, trade-order resampling only

Added the same day as the benchmark comparison above, but for a different reason: unlike
benchmark comparison, this one never needed new data — it was buildable from day one, just not
built yet. `computeMonteCarloFan` (`packages/metrics/src/robustness.ts`) bootstrap-resamples
(with replacement) a run's own closed-trade net P&L sequence `MONTE_CARLO_ITERATIONS` (1000)
times, walks each resampled sequence as an equity path from `initialCapital`, and reports
percentile bands (`p5`/`p25`/`p50`/`p75`/`p95`) of each path's final return % and max drawdown
%. Wired into `getValidationLabReport` from the same `targetTrades`/`initialCapital` already
loaded for every other panel — no new query.

**Deterministic, not `Math.random()`.** A seedable PRNG (`mulberry32`, seeded with the fixed
constant `MONTE_CARLO_SEED`) means the same trade ledger always produces the same fan, on every
reload — required by CLAUDE.md 4's reproducibility rule, which a page that resimulates
differently on every request would quietly violate. `calculationVersion`, `iterations`, and
`seed` are all echoed in the response, the same "state the exact inputs, not just the output"
pattern `computedAt` and echoed run ids use elsewhere in this report.

**What this measures, stated plainly, not left implicit.** Every resampled path draws only from
this run's own realized trade outcomes — it can reorder them, repeat them, or omit them, but it
can never invent an outcome this run never had. That makes it a measure of exactly one thing:
how much *trade-order luck alone* shaped this run's own equity curve. It says nothing about
parameter robustness (a different parameter set), regime sensitivity (a different market
period), or what would happen with a genuinely different set of trades — those remain listed
as unbuilt below, for the reasons already given there. A run with no closed trades, or a
non-positive `initialCapital`, reports `monteCarloFan: undefined` rather than an empty or
zero-valued fan.

## Alternatives considered

**Pick a single "the" IS/OOS comparison (e.g. most recent OOS run) instead of returning every
match.** Rejected — inventing a tie-break rule when zero, one, or many siblings can legitimately
exist adds a hidden selection policy with no basis in the spec. Returning every match, sorted
most-recent-first, with an explicit empty state, is both simpler to implement and more honest.

**Give trade-removal concentration a fixed N (e.g. "top 5 trades")** instead of the full curve.
Rejected for the reason in Decision item 3 — N would silently become the definition of the
test rather than a display choice.

**Reuse `listBacktestRuns` for the sibling lookup.** Rejected — that function is
cursor-paginated ascending with a default 20-row page, built for a UI list, not for "every
matching sibling, most-recent-first, filtered on symbol/timeframe/status." `validation-lab.ts`
queries `backtestRuns`/`strategyVersions`/`strategies` directly instead.

## Consequences

- Adding a real regime classifier later (there is none anywhere in this repo today, despite
  `BacktestSegmentKind` already including a `REGIME` value) slots into the same sibling-lookup
  plumbing this slice built for IS/OOS — `comparisonSegmentKinds()` in `validation-lab.ts` is
  written generically enough to extend, not rebuilt.
- "Long/short breakdown" has no named panel in §15.8's UI list — it's a §7.7 test only. This
  page's panel is additive to the spec'd UI, not a completion of one of its named entries.
- Remaining unbuilt (per §7.7/§15.8, listed explicitly on the new page itself, not just here):
  parameter stability heatmap, neighbourhood survival, cost/slippage sensitivity, entry delay,
  missed-trade simulation, start-date sensitivity, symbol transfer, regime breakdown,
  multiple-testing penalty. Local-vs-TradingView parity and the repainting review are not
  re-listed as gaps — parity already exists (the Parity panel on the backtest-run page);
  repainting review has no dedicated UI yet but is a Pine-lint-time concept (`packages/pine`),
  not a robustness-test-time one. Benchmark comparison and Monte Carlo fan, listed here
  originally as unbuilt, were added 2026-08-26 — see Decision above.

## Security implications

None beyond the existing org-scoped read pattern: `getValidationLabReport` derives every
sibling run from the already-ownership-checked target run (`getBacktestRun`) and never accepts
a second, client-supplied run id — so no additional `backtestRunBelongsToOrg` check is needed
anywhere in this service. If a future slice ever lets a user pick which run to compare against
explicitly, that id needs its own ownership check — it doesn't fall out of this design
automatically. `loadDatasetBars` (benchmark comparison) reads `target.datasetVersionId`, itself
only ever populated by `createBacktestRun` under the caller's own organisation — but
`loadDatasetBars` re-scopes to `organisationId` in its own query rather than trusting that,
matching this ADR's existing pattern of never trusting a foreign-key value alone for isolation.

## Migration/rollback

None — no schema change. Rollback is deleting the new route, service, page, and
`packages/metrics/src/robustness.ts`; nothing else depends on them. Benchmark comparison's
`loadDatasetBars` (`apps/api/src/services/datasets.ts`) is additive to that same file and safe
to delete alongside it without touching `createDatasetVersion` or anything else there. Monte
Carlo fan adds no dependency of its own — it's pure functions over data every other panel here
already loads, so rolling it back is deleting `computeMonteCarloFan` and its call site alone.
