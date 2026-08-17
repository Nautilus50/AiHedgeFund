# ADR 0011: Portfolio Research, first slice — correlation, exposure overlap, and concentration

## Status

Accepted — 2026-08-17. Implemented across `packages/metrics`, `apps/api`, and `apps/web`'s new
`/portfolio-research` page.

## Context

AI_RESEARCH_HEDGE_FUND_SPEC.md §7.11 (Phase 2 lane — Portfolio Researcher) evaluates approved
strategies as a portfolio: return/drawdown correlation, signal overlap, exposure overlap,
market/venue concentration, strategy-family concentration, turnover/fee concentration,
capacity assumptions, portfolio-level stress tests, risk-budget proposals, strategy
redundancy/replacement analysis. Most of these need data or methodology this repo doesn't
have: a tagging/family system, real liquidity/ADV data, or a real stress-test/risk-budget
methodology this session won't improvise. This slice builds what's genuinely computable from
existing `backtest_runs`/`trades`/`equity_points`/`drawdown_points` data for an organisation's
PAPER_APPROVED strategies: return correlation, drawdown correlation, exposure overlap, market
concentration, and turnover/fee concentration.

**A Plan-agent review caught a real correctness bug in the original design**, not just a
soundness nuance, and it shaped everything below: `equity_points`/`drawdown_points` are
**trade-close-event series, not a regularly-sampled daily grid**.
`apps/worker-analytics/src/handlers.ts`'s `handleEquityReconstruction` writes one row per
closed trade, timestamped by that trade's `exitTime` — most calendar days have zero rows for
a given run, and a day with two trades closing has two. A naive "join on calendar day, compute
day-over-day return" design would have (a) produced duplicate rows on multi-close days, (b)
paired mismatched-period returns (a 3-week gap for one strategy against a 1-day gap for
another, both called "the return for that day"), and (c) biased correlation upward, since the
days that survive an inner join are exactly the days both strategies happened to close a trade
— plausibly volatility-spike days when many stops fire together across otherwise-unrelated
strategies.

## Decision

### Same-day dedup, not a daily grid

`toDailyEquitySeries`/`toDailyDrawdownSeries` (`packages/metrics/src/portfolio.ts`) collapse
same-day duplicate points to the highest-`sequenceNumber` (most recent) reading that day —
never an average, never a naive last-by-clock-time (a later-sequenced point can have an
earlier wall-clock `barTime` is not actually possible given `sequenceNumber` is assigned in
exit-time order by `reconstructEquityCurve`, but the dedup logic keys on `sequenceNumber`
specifically to stay correct even if that ever changes). Returns are computed between
consecutive *available* days, not consecutive calendar days — an irregular-period return by
construction, named honestly as such in the methodology note the API response and UI both
surface, not silently presented as "the daily return."

### The honest ceiling: realized P&L timing, never held exposure

Because equity only updates at trade close and this repo has no periodic mark-to-market for
open positions, this feature can only ever measure correlation of *when strategies realize
P&L*, not correlation of concurrent market exposure. Stated plainly in
`getPortfolioCorrelationReport`'s `methodologyNote` (rendered on the page itself, not just
here) — the same "state the ceiling honestly" pattern `SubsetMetrics` used in ADR 0009 for
sequence-shaped fields that would misrepresent a filtered subset.

### Spearman, not Pearson, for both correlation types

`computeSpearmanCorrelation` ranks both series then Pearson-correlates the ranks. Two
independent reasons, not one: equity returns here are irregular-period (undermining Pearson's
linearity assumption further than ordinary fat-tailed-returns concerns already would), and
drawdown *levels* are strongly serially autocorrelated — once in a drawdown, adjacent points
stay elevated together, which produces spurious level-correlation between two unrelated
strategies that each simply had one drawdown episode sometime in the sample window. That's a
classic integrated-series correlation trap; drawdown being *bounded* doesn't make it
*stationary*, and boundedness alone doesn't excuse using levels naively.

### `MIN_OVERLAP_DAYS = 10` — a named constant, with the real failure mode stated

The first invented statistical constant in `packages/metrics` (no analogous threshold exists
anywhere else in the package to borrow from). Below it, a pair reports `coefficient: null`
with `reasonCode: "INSUFFICIENT_OVERLAP"` — but the concrete failure mode at the threshold
isn't generic small-N noise, it's that the surviving overlap days skew toward
correlated-shock days (both strategies happening to close a trade the same day is
disproportionately likely on volatility spikes), which biases the coefficient upward, not
just widens its variance. The response always echoes both the raw overlap-day count and
overlap as a % of the *union* of both strategies' available days — "10 of 12 possible" and
"10 of 400 possible" are very different reliability signals that a bare day-count hides.

### Representative-run selection — a deliberate departure from ADR 0009's precedent

No "canonical backtest run" concept exists anywhere in this repo — `backtest_runs` is
one-to-many against `strategy_versions`. ADR 0009 (Validation Lab) explicitly rejected picking
a single "the" comparison run, reasoning that "inventing a tie-break rule... adds a hidden
selection policy with no basis in the spec," and returned every matching sibling instead. This
slice does the opposite — picks exactly one representative run per strategy, ordered by
`segmentKind` preference (`OUT_OF_SAMPLE > VALIDATION > IN_SAMPLE > everything else`), then
most recent — **for a reasoned, stated reason**: a correlation *matrix* needs one node per
strategy to be well-defined at all, where Validation Lab's *pairwise list* didn't. This isn't
an oversight of the earlier precedent; it's a different problem shape. Every pair's response
includes `evidenceTierMismatch: boolean` (true when the two strategies' representative runs
differ in `segmentKind`) so a viewer isn't left cross-referencing two segment-kind strings to
notice they're comparing in-sample against out-of-sample evidence — the UI marks it with a
visible ⚠. A strategy with no `SUCCEEDED` run at all is excluded from the matrix and listed
separately, never zero-filled.

### Exposure overlap — the cheap, honest win Validation Lab's precedent suggested looking for

`computeExposureOverlap` sums pairwise interval overlaps between two strategies' closed
trades' `[entryTime, exitTime]` windows, expressed as a Jaccard index (bounded 0-100%,
`overlap / union` of both strategies' total in-market time). This is a materially more honest
signal than the close-day correlation above — it measures actual concurrent exposure, not
coincidence of exit days — computed from data already loaded for turnover, no new query. O(n·m)
pairwise, not a sweep-line: a documented complexity ceiling, not fixed preemptively for trade
counts this stage doesn't have. Assumes one open position at a time per strategy (no
pyramiding — true of every runner in this codebase today), so a strategy's own trades are
treated as non-overlapping with each other when summing total in-market time.

### Query-composition safety for `strategyVersionIds`

`resolvePaperApprovedStrategies` extends `resolveFilteredStrategyIds`'s LATERAL
"latest-version-per-strategy" pattern (`strategy-registry.ts`) with the `PAPER_APPROVED`
filter and, when supplied, an id-list filter — **inside the same query's `WHERE`, composed
with the organisation clause**, never a separate post-filter step. ADR 0009's own
"Consequences" section named this exact risk for a future slice that lets a caller supply ids;
this is where it's resolved, not left open again.

### Turnover/fee concentration — quote-currency assumption stated, not fixed

`quantity * entryPrice` is quote-currency notional, which already solves the price-scale
problem across symbols (a $100k BTC fill and a $100k altcoin fill both read as $100k). What it
does *not* solve: `symbol` is free text with inconsistent formats across existing data
(`"BTCUSD"`, `"BYBIT:BTCUSDT.P"`, `"COINBASE:BTCUSD"`), and no quote-currency field exists
anywhere to verify against. This metric silently assumes every selected strategy's symbol is
quoted in the same currency. Not fixed — there's no reliable field to normalize from without
inventing a symbol parser — but stated plainly in the methodology note, and the raw symbol is
shown per strategy in the turnover table so a reader can eyeball whether the assumption holds
for their own set.

## Alternatives considered

**Pearson correlation.** Rejected for both series types — see Decision above.

**No minimum-overlap threshold; always report a coefficient.** Rejected — a 2-3-point
correlation would present as authoritative as a well-supported one with no signal to tell them
apart.

**Reuse Validation Lab's "return every matching sibling" approach instead of picking a
representative run.** Rejected for this feature specifically — a pairwise correlation matrix
needs exactly one node per strategy; returning every sibling run per strategy would mean every
pair has an unbounded number of possible comparisons with no way to pick which to display.

## Consequences

- Remaining unbuilt (listed explicitly on the page itself, not just here): signal overlap (no
  indicator/entry-condition introspection exists anywhere in this repo), strategy-family
  concentration (no tagging system), capacity assumptions (no liquidity/ADV data),
  portfolio-level stress tests, risk-budget proposals, strategy redundancy/replacement
  analysis (all need real methodology this session won't improvise).
- If a future slice adds a real quote-currency field to `backtest_runs`/`symbol`, the
  turnover-concentration assumption documented above should be revisited and either verified
  or the metric restricted to same-currency subsets.

## Security implications

None beyond the existing org-scoped read pattern — every strategy in the matrix is derived
from an organisation-scoped LATERAL query, and the `strategyVersionIds` filter is composed
into that same query rather than applied afterward (see Decision), closing the exact gap ADR
0009 flagged for a future slice.

## Migration/rollback

None — no schema change, no new table. Rollback is deleting the new route, service, page, and
`packages/metrics/src/portfolio.ts`; nothing else depends on them.
