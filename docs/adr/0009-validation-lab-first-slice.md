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
  parameter stability heatmap, neighbourhood survival, Monte Carlo fan, cost/slippage
  sensitivity, entry delay, missed-trade simulation, start-date sensitivity, symbol transfer,
  regime breakdown, multiple-testing penalty, benchmark comparison. Local-vs-TradingView parity
  and the repainting review are not re-listed as gaps — parity already exists (the Parity panel
  on the backtest-run page); repainting review has no dedicated UI yet but is a Pine-lint-time
  concept (`packages/pine`), not a robustness-test-time one.

## Security implications

None beyond the existing org-scoped read pattern: `getValidationLabReport` derives every
sibling run from the already-ownership-checked target run (`getBacktestRun`) and never accepts
a second, client-supplied run id — so no additional `backtestRunBelongsToOrg` check is needed
anywhere in this service. If a future slice ever lets a user pick which run to compare against
explicitly, that id needs its own ownership check — it doesn't fall out of this design
automatically.

## Migration/rollback

None — no schema change. Rollback is deleting the new route, service, page, and
`packages/metrics/src/robustness.ts`; nothing else depends on them.
