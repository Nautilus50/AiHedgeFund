# ADR 0012: Forward-test drift report and persisted health snapshots

## Status

Accepted — 2026-08-17. Implemented across `packages/metrics`, `packages/db`, `apps/api`, and
`apps/web`'s forward-deployment detail page and its new `/drift` sub-page.

## Context

ADR 0006 (forward-test paper engine's first slice) explicitly deferred two things this slice
picks up: a persisted `health_snapshots` time series (`/health` was, and still is on every
live read, computed on demand with no history) and a `DriftReport` comparing forward
performance against backtest expectations, rejected outright at the time because it "needs a
defined statistical methodology (spec 7.8 names it but doesn't specify one) that shouldn't be
improvised inside an otherwise infrastructure-focused change."

The ground has shifted since ADR 0006 landed, in ways this ADR relies on rather than
re-litigates:

- `apps/worker-forward/src/handlers.ts`'s `recomputeForwardCurves` already computes full
  `CoreMetrics` for a forward deployment on every closing fill, via the same
  `calculateCoreMetrics`/`reconstructEquityCurve`/`computeDrawdownCurve` functions the backtest
  chain uses, completely unchanged.
- `packages/metrics/src/robustness.ts`'s `computeDegradation(baseline, comparison)`, built for
  Validation Lab (ADR 0009), is a pure function over two `SubsetMetrics` objects with zero
  backtest-specific coupling.
- `apps/api/src/scripts/reap-abandoned-uploads.ts` already answered "how does something run
  periodically in this repo": an operator/external-scheduler-invoked script, because this repo
  has no in-process cron and ADR 0006/0007 argued against inventing one ahead of need.

## Decision

### Reusing `computeDegradation` is not "inventing a statistical methodology"

ADR 0006's actual objection was to an **undefined** methodology — spec 7.8 names `DriftReport`
without specifying one. `computeDegradation` is not undefined; it's the methodology this repo
already committed to for exactly this "before vs after" shape of comparison (relative %
change in net profit and profit factor, percentage-point difference in win rate), already in
production use for Validation Lab's IS/OOS comparisons. Applying an existing, tested,
documented function across a different pair of inputs (backtest metrics vs. forward metrics,
instead of backtest metrics vs. backtest metrics) is not improvising a new statistical
method — it's the same method, honestly labelled as such in the response's own
`methodologyNote` (surfaced on the `/drift` page, not just here): explicitly **not** a
statistical drift test — no p-value, no distribution or regime comparison, no live
market-data-based expected-vs-observed price tracking. That last piece — ADR 0006's other
named gap — remains genuinely unbuilt; nothing here addresses it.

Both sides of the comparison are computed **live** from raw trade/fill rows — `getTrades` for
the baseline backtest run (same as Validation Lab), `paperFills` joined to `paperOrders` via
`pairPaperFillsIntoTrades` for the forward side — never read from the write-only
`metric_snapshots` rows `recomputeForwardCurves` already writes. This matches Validation Lab's
own convention of always recomputing rather than trusting a stored snapshot, and sidesteps any
question of whether the write-only rows are stale.

### `pairPaperFillsIntoTrades` moved to `packages/metrics`

`apps/worker-forward/src/fill-pairing.ts` had zero worker-specific coupling — a pure function
pairing ENTRY/EXIT fills into `MetricsTrade[]`. Moved to `packages/metrics/src/fill-pairing.ts`
so the drift report (in `apps/api`) and `recomputeForwardCurves` (in `apps/worker-forward`) call
the identical function. This added zero new dependency edges: `apps/api` already depends on
`@arf-os/metrics` (used by Validation Lab and Portfolio Research).

### A minimum forward-trade floor, justified from `computeDegradation`'s own failure mode

Below 5 closed forward trades, the drift report returns `reasonCode: "INSUFFICIENT_FORWARD_TRADES"`
instead of a degradation result. The reasoning is specific to this comparison, not borrowed from
`MIN_OVERLAP_DAYS` in `packages/metrics/src/portfolio.ts` (that threshold guards against
correlated-shock bias in a *correlation*; this one guards against single-trade dominance in a
*percentage*): with fewer than ~5 closed trades, `winRatePct` can only land on one of a handful
of coarse values (0/20/25/33/50/100), and a single losing trade can read as up to 100% "net
profit degradation" — a number that looks precise while being entirely determined by whichever
trade happened to close most recently.

### Sweep script, not a BullMQ repeatable job — mirroring `reap-abandoned-uploads.ts`

The original design considered a BullMQ `repeat` option (`Queue.add(..., {repeat})`), reasoning
that it's a stock feature of an already-installed dependency, not new infrastructure. A
Plan-agent review found a better-precedented answer already in this repo:
`reap-abandoned-uploads.ts` solved "we need something to run periodically" once already, and
its own doc comment states why — no in-process scheduler exists, so the trigger lives outside
the app (an operator, or the deployment platform's own cron). `apps/api/src/scripts/sweep-health-snapshots.ts`
mirrors that script's exact shape: `[organisationId] [--dry-run]` CLI args, no-arg default of
"every organisation," wired to `apps/api/package.json`'s `health-sweep` script. This was
preferred over BullMQ `repeat` because it reuses a pattern this repo already chose once, rather
than establishing a second, different answer to the same question, and avoids being the first
place in this codebase to reason about repeat-job restart/missed-tick semantics.

### Idempotency: pre-query and skip, not `ON CONFLICT`

`sweepHealthSnapshots(db, organisationId, tickAt, dryRun)` takes one `tickAt` shared across the
whole sweep run. For each `ACTIVE` deployment, it checks whether a `(deploymentId, tickAt)` row
already exists and skips if so, rather than using `ON CONFLICT` (no `ON CONFLICT` clause exists
anywhere in this codebase today — every existing idempotency mechanism, from `paper_orders.signal_event_id`'s
uniqueness check to the API's `idempotency_records` table, is check-then-write). A retried
sweep after a partial failure — the concrete scenario CLAUDE.md 3.6 requires background jobs to
handle — is a safe no-op: re-running the script with a freshly-computed `tickAt` only affects
deployments that haven't been snapshotted for that instant yet.

### `resolveRepresentativeRun` exported for a second caller — the safety invariant it relies on

The drift report's baseline is one representative backtest run per strategy version, resolved
via `resolveRepresentativeRun` (`portfolio-research.ts`, built for ADR 0011), now exported.
That function has **no internal organisation check** — it was, and remains, safe only because
every caller has already verified the `strategyVersionId` it's given belongs to the caller's
organisation. `getPortfolioCorrelationReport` does this via its own organisation-scoped LATERAL
query; the drift report does it via `deployment.strategyVersionId`, which came from
`getForwardDeployment`'s organisation-scoped join. Any future third caller must do the same —
this function does not, and should not, re-check it itself (it has no organisation parameter to
check against).

### Frontend split: a card for history, a sub-page for the report

Health-snapshot history is a straightforward historical extension of the existing live "Health"
card on the forward-deployment detail page — added as a new card immediately below it, same
page. The drift report is a distinct multi-field report (baseline run identity, degradation
numbers, its own methodology note) bolted onto an already-dense detail page — it gets its own
route, `/forward-deployments/[id]/drift`, mirroring Validation Lab's precedent of
`/backtest-runs/[id]/validation` as a separate route rather than a sixth card.

## Alternatives considered

**BullMQ `repeat` for the health-snapshot sweep.** Rejected — see Decision above. A real
alternative, not a strawman; ultimately rejected for reusing a worse-fitting pattern than one
this repo already has.

**Snapshotting health synchronously as a side effect of `handleForwardSignalProcessing`.**
Rejected — the scenario operators most need a snapshot to catch is exactly the one where
signals *stop arriving* (a misconfigured or broken TradingView alert). A snapshot that only
fires when a signal is processed can never observe that, and it would couple an unrelated
monitoring concern into the one hot transactional path ADR 0006 kept deliberately narrow.

**Reading forward metrics from the existing `metric_snapshots` rows instead of recomputing live.**
Rejected for consistency with Validation Lab's established convention (see Decision) — not
because the stored rows are wrong, just to keep exactly one code path computing "what are this
deployment's metrics right now."

## Consequences

- Still not built: any live market-data-based expected-vs-observed price comparison (ADR 0006's
  other named gap), and any push/SSE delivery of health snapshots — both live/health data stay
  polled, the same deliberate deviation from CLAUDE.md 17.4 ADR 0006 already documented.
- `sweep-health-snapshots.ts` is not wired to any in-repo scheduler — like `reap-abandoned-uploads.ts`,
  it needs an operator or the deployment platform's own cron to actually run periodically.
- If a future slice adds a real quote-currency-normalized or regime-aware statistical drift
  test, this ADR's `computeDegradation`-based comparison should be treated as a superseded first
  slice, not extended in place — the methodology-reuse argument above depends on it being
  labelled honestly as *not* that.

## Security implications

None beyond the existing org-scoped read pattern: both new routes
(`GET .../health-snapshots`, `GET .../drift-report`) go through `getForwardDeployment`'s
organisation-scoped join before touching any new table, exactly like every other route in
`forward.ts`. The sweep script runs with the same trust boundary as `reap-abandoned-uploads.ts` —
an operator-invoked, non-HTTP process, not a public route.

## Migration/rollback

One new table (`health_snapshots`, FK cascade to `forward_deployments`), two new routes, one new
script, and `pairPaperFillsIntoTrades`'s relocation (a pure move, no behaviour change — its test
moved with it). Rollback: drop the new routes and script; the table can stay empty and unused
without effect on any existing chain. Reverting `pairPaperFillsIntoTrades`'s move would require
re-adding the file to `apps/worker-forward` and updating one import line back.
