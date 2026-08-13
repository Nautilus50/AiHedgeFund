# ADR 0006: Forward-test paper engine — first vertical slice

## Status

Accepted — 2026-08-13. First vertical slice implemented across
`packages/contracts`, `packages/db`, `packages/event-bus`, `apps/api`, and
`apps/worker-forward`.

## Context

`apps/worker-forward` was a health-endpoint stub — CLAUDE.md §16 and spec
Lane 7 (Forward-Test Operator) were entirely unbuilt, the largest remaining
piece of the platform. Two pieces of infrastructure already existed, unused,
clearly anticipating this work: `packages/contracts/src/signal-event.ts` (a
complete, tested `SignalEvent` schema and `signalIdempotencyKey` helper) and
`DomainEventType`'s `"forward_signal.received"` / `metricScopeEnum`'s
`"FORWARD_DEPLOYMENT"` entries.

The spec's full Lane 7 scope (drift reports comparing forward against
backtest expectations, a persisted `health_snapshots` time series with
scheduled computation, live market-data-based "expected vs observed price"
comparison, SSE-pushed deployment health, a separate `forward_test_plans`
planning table) is a multi-phase effort on top of a platform that has no
scheduled/cron job mechanism and no live price-feed integration at all.
Building all of it first would mean building ahead of what a first working
slice needs, and would risk shipping something that looks complete while its
gaps are undiscoverable until a real forward test runs.

## Decision

A real, honestly-scoped first vertical slice: an operator deploys a
`PAPER_APPROVED` strategy version, receives real TradingView alert webhooks,
gets deterministic paper fills, and sees a real equity/drawdown curve and a
two-axis health status — with every CLAUDE.md §16 rule actually enforced.

1. **Ingestion** (`apps/api/src/services/forward-signals.ts`) implements
   CLAUDE.md 16.1's checklist in order: token lookup (constant-shape 404 on
   no match), deployment-ACTIVE check, `SignalEvent.safeParse`,
   deployment/symbol/timeframe/timestamp-tolerance validation, idempotency
   key via the existing `signalIdempotencyKey(payload, payload.eventId)` —
   `eventId` is read as TradingView's own alert/order id (Pine's
   `{{strategy.order.id}}`), making the key fully computable from the
   payload alone. Only failure modes with a full, valid `SignalEvent`
   persist a `signal_events` row; an unparseable body has no reliable fields
   to build a key from, so nothing is persisted for it — a narrow, explicit
   scope limit, not a silent gap. No paper logic runs synchronously; a valid
   signal only writes the raw row and emits `forward_signal.received`.
2. **Processing** (`apps/worker-forward/src/handlers.ts`,
   `handleForwardSignalProcessing`) turns one signal into a deterministic
   paper fill (or a recorded rejection) inside one transaction, including
   the deployment-state re-check — no partial-state window between checking
   `ACTIVE` and writing a fill. One open position at a time, no pyramiding
   (consistent with every other runner in this repo): an `ENTRY_*` is
   rejected while one is open; an `EXIT_*`/`STOP_HIT`/`TARGET_HIT` is
   rejected if nothing is open. `paper_orders.signal_event_id` is UNIQUE —
   the idempotency guard against a BullMQ redelivery of the same job.
3. **Fill model** (`ForwardFillModel` in `packages/contracts/src/forward.ts`)
   declares every CLAUDE.md 16.2 required field — fill-model version,
   latency model, slippage model, commission model, quantity model,
   stop/target rule — deliberately its own shape rather than reusing
   `backtest.ts`'s `CostModel` (which bundles `slippageTicks` into the
   commission model, which would give a forward deployment two sources of
   truth for slippage). `stopTargetRule: "external_alert_only"` is an
   honest declared value: TradingView's own alert reports a stop/target hit
   (`SignalEvent`'s `STOP_HIT`/`TARGET_HIT` event types) — ARF-OS does not
   simulate live stop/target monitoring against a price feed it doesn't
   have. A deployment's fill model is never edited after creation — a
   change means a new deployment.
4. **Evidence** reuses `@arf-os/metrics`'s existing pure functions
   (`reconstructEquityCurve`, `computeDrawdownCurve`, `calculateCoreMetrics`)
   completely unchanged — zero new equity/metrics math. A new
   `pairPaperFillsIntoTrades` (`apps/worker-forward/src/fill-pairing.ts`)
   pairs ENTRY/EXIT fills into the same `MetricsTrade[]` shape the backtest
   chain already produces, mirroring the entry/exit-pairing shape in
   `packages/pine`'s list-of-trades parser. `forward_equity_points` /
   `forward_drawdown_points` are exact mirrors of `equity_points` /
   `drawdown_points`, structurally separate tables (never the same rows as a
   backtest run — CLAUDE.md 18.1: historical and forward equity are never
   one uninterrupted series). `metric_snapshots` is reused as-is with the
   pre-anticipated `scopeType = "FORWARD_DEPLOYMENT"`.
5. **Health** (`GET /v1/forward-deployments/:id/health`) reports two
   independent axes per CLAUDE.md 16.3 ("infrastructure degradation must be
   tracked separately from strategy performance"): `infrastructureHealth`
   from the real rejection rate over the deployment's recent signals (a
   genuine signal-quality/configuration fact, not fabricated), and
   `strategyPerformanceHealth` compared against an operator-configured
   `maxDrawdownPctAlertThreshold` — `NOT_CONFIGURED` rather than a
   fabricated default when none was set. Computed live on read; no stored
   snapshot table, no scheduled job.
6. **Security**: the deployment token is a `crypto.randomBytes(32)`
   high-entropy secret (no existing token-generator utility in the repo, so
   a small new one was written — `apps/api/src/lib/tokens.ts`); only its
   sha256 hash is ever persisted, and the plaintext is returned exactly once
   in the create-deployment response. Because TradingView's alert UI cannot
   send custom headers, the token travels as a URL path segment
   (`POST /v1/webhooks/tradingview/:deploymentToken`) — a custom Fastify log
   serializer (`apps/api/src/lib/log-redaction.ts`) redacts it from every
   request log line. The webhook route is rate-limited by a hash of the
   token itself, not the caller's IP: TradingView's webhook calls all
   originate from TradingView's own small server-IP pool, so IP-keying (the
   global default) would pool every organisation's forward-test traffic
   into one shared budget.

## Alternatives

- **Wait for a scheduled-job mechanism before building health.** Rejected —
  this repo has no cron/interval infrastructure at all, and inventing one
  just to support a stored `health_snapshots` time series for a first slice
  would be building speculative infrastructure ahead of the feature that
  needs it (CLAUDE.md 3.8's spirit, applied here rather than to browser
  automation). Computing health live on read is simpler, honest about what
  exists, and directly upgradable to a snapshot table later without an API
  shape change.
- **Reuse `backtest_runs`/`trades`/`equity_points`/`drawdown_points` with a
  nullable/polymorphic foreign key.** Rejected — spec 14.4 lists "Forward
  testing" as its own table group, separate from "Testing" (backtest), and
  CLAUDE.md 18.1 requires historical and forward evidence to never blur into
  one series. A shared table with a nullable `backtest_run_id` XOR
  `forward_deployment_id` would make that blur structurally possible; fully
  separate tables make it structurally impossible.
- **Simulate live stop/target monitoring against a price feed.** Rejected —
  no market-data integration exists in this repo, and building one only to
  half-support it (paper-only, no real venue) would be a bigger, riskier
  addition than this slice's actual goal. TradingView's own Pine strategy
  alert already reports when its stop/target triggers; ARF-OS records that
  report rather than re-deriving it.
- **`DriftReport` (statistical comparison of forward trade frequency and
  distribution against backtest expectations).** Rejected for this slice —
  it needs a defined statistical methodology (spec 7.8 names it but doesn't
  specify one) that shouldn't be improvised inside an otherwise
  infrastructure-focused change.

## Consequences

- CLAUDE.md 17.4 explicitly names "forward deployment health" as an SSE use
  case. This slice polls (`GET .../health`) instead — a deliberate,
  documented deviation from that rule, not a silent drop. Revisiting it is
  the natural trigger for also building a stored health-snapshot table,
  since SSE implies pushing discrete snapshots, not re-running a live query
  per connected client.
- `fixed_ticks` slippage is treated as an absolute price delta, not a
  per-symbol tick size — this repo has no tick-size table for any symbol
  (the same honest limitation ADR 0005's local runner already declares for
  backtest slippage).
- A sibling strategy version can be approved and superseded while a
  deployment keeps running against the version it was created for —
  `PAPER_APPROVED` is a `TERMINAL_STATES` entry (`packages/workflow`), so
  the deployment's own version can never itself change, but nothing stops a
  newer version from existing. `GET /v1/forward-deployments/:id` surfaces
  `newerApprovedVersionExists` so a human notices; nothing pauses or
  redirects the deployment automatically.
- No `forward_test_plans` table — a deployment's full configuration is
  captured at creation on `forward_deployments` itself. A future "plan
  before deploying" workflow (e.g. requiring a minimum planned duration
  before promotion) would need to add one.
- The frontend (`apps/web/app/forward-deployments/[id]/page.tsx`) reuses the
  exact same `EquityDrawdownChart` component built for backtest runs
  unchanged — the two point tables share column names by design (§4 above),
  so no adapter was needed.

## Security implications

The deployment token is the sole authentication for a public,
Clerk-session-free endpoint (`POST /v1/webhooks/tradingview/:deploymentToken`)
— CLAUDE.md 16.1 requires exactly this shape, since TradingView's servers
cannot carry a user session. Mitigations: 32 bytes of `crypto.randomBytes`
entropy; only the sha256 hash is ever persisted or logged (custom log
redaction, above); a constant-shape 404 on an unknown token (no
"token exists but deployment inactive" vs "token doesn't exist" distinction
leaked to the caller); per-token rate limiting so one compromised or
misconfigured token cannot exhaust another deployment's budget. A leaked
token only allows submitting paper signals to one deployment — no live
funds, no live orders exist anywhere in this codebase (CLAUDE.md 3.9).

## Migration / rollback

Purely additive: six new tables (`forward_deployments`, `signal_events`,
`paper_orders`, `paper_fills`, `forward_equity_points`,
`forward_drawdown_points`), a new outbox event type routed to a new BullMQ
queue, and new API routes — nothing existing is modified except
`metric_snapshots`' pre-existing `scopeType` enum (already had
`FORWARD_DEPLOYMENT` before this change) and `docs/architecture.md`'s outbox
routing table. Rolling back means not registering `apps/worker-forward`'s
`forwardSignalProcessing` consumer and not exposing the new routes; the new
tables can stay empty and unused without effect on any existing chain.
