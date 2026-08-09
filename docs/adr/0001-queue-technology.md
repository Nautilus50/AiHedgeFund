# ADR 0001: Redis + BullMQ for background jobs, with a transactional outbox

## Status

Accepted — 2026-08-08. Implemented in Milestone 12.

## Context

ARF-OS runs work that must not happen inside a request: report parsing,
trade normalisation, equity reconstruction, metric calculation, parity
comparison, and agent runs. CLAUDE.md 3.6 requires every one of those to be
idempotent, and 3.2 forbids workers from changing lifecycle state directly —
they execute, store artefacts, and emit results for the API to act on.

That combination rules out the naive approach of enqueueing a job from inside
a request handler. If the API commits a database transaction and then fails to
enqueue, the work is silently lost; if it enqueues first and the transaction
rolls back, a worker acts on state that does not exist.

## Decision

Use **Redis + BullMQ** for queues, fed by a **transactional outbox**.

Domain events are written to `outbox_events` in the same transaction as the
state change they describe. A separate relay process (`apps/worker-backtest`)
claims committed rows and publishes them to BullMQ.

Three properties make this safe:

- **Atomic emit.** The event and the state change share a transaction, so
  neither can exist without the other.
- **Exclusive claim.** The relay claims with `SELECT ... FOR UPDATE SKIP
  LOCKED` and flips rows to `PUBLISHING` in the same statement, so the claim
  survives past commit and concurrent relay replicas take disjoint sets.
- **Deterministic job ids.** Each routed job's id derives from its outbox row
  id, so a relay that crashes after publishing but before marking the row
  re-publishes onto the same id, which BullMQ collapses.

Rows stranded in `PUBLISHING` by a crashed relay are returned to `PENDING` by
`reclaimStale()`.

## Alternatives

- **Enqueue directly from the request handler.** Simplest, and wrong: no way
  to make the enqueue and the database commit atomic.
- **Postgres-only queue (e.g. pgboss, LISTEN/NOTIFY).** Removes Redis
  entirely and would keep everything in one transactional store. Rejected for
  now because BullMQ's retry/backoff/observability surface is materially
  better and the spec already commits to Redis. Worth revisiting if Redis
  becomes the only reason to run a second datastore.
- **Kafka or similar log.** Correct ordering and replay semantics, but
  disproportionate operational weight for a single-tenant research platform at
  this stage.

## Consequences

- Two processes must be running for background work to flow: the relay and
  the consuming worker. A stalled relay is invisible from the API's
  perspective, so outbox depth needs monitoring (spec 18.2).
- Events are at-least-once, not exactly-once. Every handler must tolerate
  redelivery — `handleEquityReconstruction` and `handleMetricCalculation`
  both delete-then-insert per run for this reason.
- An event type with no route is marked `PUBLISHED` and dropped rather than
  retried forever. Adding a subscriber later means those historical events
  will not be replayed.
- Job ids must not contain `:` — BullMQ reserves it as its internal Redis key
  separator. This was found only by running against real BullMQ; the unit
  suite's fake publisher does not enforce it.

## Security implications

- Redis holds job payloads. Those payloads carry aggregate ids, never
  credentials or protected holdout results.
- The relay runs with the same database credentials as the API; it does not
  need object-store or model-provider access.
- Redis is not exposed publicly; it is reachable only from the application
  network.

## Migration / rollback

Rolling back to direct enqueueing would mean accepting lost or phantom jobs
and is not recommended. Migrating to a Postgres-only queue would keep the
outbox table and replace only the publisher, since `JobPublisher` is a
one-method port.
