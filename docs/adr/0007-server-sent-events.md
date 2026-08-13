# ADR 0007: Server-sent events — resumable live updates, first slice

## Status

Accepted — 2026-08-13. First vertical slice implemented across
`packages/db`, `apps/api`, `apps/worker-backtest`, `apps/worker-analytics`,
`packages/workflow`, and `apps/web`'s backtest-run detail page.

## Context

CLAUDE.md 17.4 requires SSE for campaign updates, job progress, and
forward-deployment health, "resumable with event IDs where practical."
Nothing existed toward this: no SSE plugin, no frontend polling anywhere in
`apps/web`, and `outbox_events` had no `organisationId` column to scope or
resume a stream by.

Two prerequisite gaps had to close before any page could be wired up. First,
this API's auth (`apps/api/src/plugins/auth.ts`) is Bearer-token-only —
browser `EventSource` cannot set an `Authorization` header, so nothing could
open a stream at all without a bridging mechanism. Second, the outbox table
itself was tenant-blind: every insert site across `apps/api`,
`apps/worker-backtest`, and `apps/worker-analytics` had to be found and
threaded with the organisation a stream filters by.

An initial three-page design (Campaign Detail, Backtest-run detail,
forward-deployment health, all in one slice) was reviewed and cut back:
landing three pages before the plumbing (ticket auth, a shared poller, the
`organisationId` backfill) had ever run for real would validate nothing
before tripling the review and rollback surface. This slice ships the
plumbing once and wires it to one page.

## Decision

**Scope: one page.** Backtest-run detail (`apps/web/app/backtest-runs/[id]/`)
gets a live-refresh client component. Campaign Detail and forward-deployment
health are deferred to a fast-follow slice once this plumbing has run
against real traffic — tracked as a backlog item, not built here. This page
was chosen deliberately over an already-working one: wiring it forced a
real, previously-missing signal (`backtest_run.completed` — nothing fired on
a run's own completion before this change) and fixed a real transactional
gap (below), so the hard parts got exercised rather than skipped.

**1. `organisationId` on `outbox_events`, NOT NULL.** Added via migration
`0010`, backfilled per event type before the constraint was applied: two
event types already carried `organisationId` in their JSON payload (no join
needed); the rest resolve it through each aggregate's own chain
(`backtest_runs → strategy_versions → strategies`, or
`signal_events → forward_deployments`). All 10 existing insert call sites
were updated to populate it going forward. A handful of already-orphaned
rows surfaced during backfill — leftover outbox rows from an earlier demo
walkthrough whose aggregate (and, in one case, whose organisation) had since
been deleted — and were dropped rather than left to force a nullable
escape hatch onto an otherwise-universal NOT NULL convention every other
tenant-owned table in this schema already follows.

**2. Ticket-based bridge for `EventSource`.** `POST /v1/sse/tickets`
(normal Bearer auth) mints a 32-byte opaque token, persists only its hash
(`sse_tickets`, mirroring the forward-deployment webhook token's pattern —
`generateDeploymentToken` was generalised to `generateOpaqueToken` since
both cases now share it), and returns the plaintext once. The ticket
travels as a URL path segment (`GET /v1/events/stream/:ticket`), not a
query string, matching the webhook route's own precedent exactly and
keeping the log-redaction regex (`redactSseTicket`, wired into `server.ts`
alongside the existing `redactWebhookToken`) trivial. It is single-use,
30-second TTL. `claimSseTicket` (`apps/api/src/services/sse-tickets.ts`)
checks validity and marks it used in the same call — not split into a
separate "check" then "burn" step — so two concurrent requests racing the
same ticket cannot both pass; the cost is that a DB hiccup during the
stream's own setup after a successful claim leaves the ticket already
spent, requiring a fresh mint, which is an acceptable trade for a
credential this narrowly scoped (30 seconds, one organisation, read-only
notifications).

**3. Delivery is one shared in-process poller, not per-connection
polling, not Redis pub/sub.** `packages/db/src/client.ts` caps the
connection pool at 10, shared with every ordinary REST request; a
per-connection 1-second poll would keep that pool saturated under a
handful of open tabs. `apps/api/src/lib/sse-hub.ts`'s `SseHub` runs one
`setInterval` per API process, reading `outbox_events` once and fanning
out matching rows in memory to every open connection — organisation and
optional `aggregateId` filtering happens in JS against a plain subscriber
list, not per-connection SQL. A new subscriber's own gap (its client-sent
`cursor` to "now") is closed with one SQL-scoped catch-up read before it
joins the live fan-out, with per-subscriber de-duplication by last-sent id
in case a row lands in both reads. This is O(1) database connections
regardless of viewer count; a multi-replica deployment runs one
independent poller per replica against the same table, which needs no
cross-replica coordination since Postgres stays the single source of
truth.

**4. Payload is a thin notification, not computed state.** Each SSE
message carries `{aggregateId, occurredAt}` and an `event:` name — never
the resource's full computed shape. The frontend reacts by calling
`router.refresh()`, which re-runs the page's own Server Component data
fetch. This keeps every computed value (equity curves, health, metrics)
single-sourced from Postgres on read, exactly as it already was; SSE only
tells a viewer when to ask again.

**5. Reconnection is hand-rolled, not native `EventSource` retry.**
Because the ticket is single-use, the browser's default reconnect (which
reopens the exact same URL, including the now-invalidated ticket) cannot be
relied on. `LiveRunUpdates.tsx`'s `onerror` handler closes the connection
itself first, then mints a fresh ticket and reopens with
`cursor=<last event id>` to resume exactly where it left off.

**6. `markFailed` (`apps/worker-backtest/src/handlers.ts`) became
transactional.** It previously issued a bare, non-transactional status
UPDATE. Emitting `backtest_run.completed` from every failure path is
exactly the CLAUDE.md 9.3 case ("state transition + event") transactional
rules exist for, so the status write and the event insert now share one
`db.transaction()`. One pre-existing inconsistency surfaced and was fixed
alongside it: a missing `datasetVersionId` used to `throw` instead of
calling `markFailed` like every other validation failure in that function
— since the run row already exists at that point, the old behaviour left
it stuck at whatever status it started in, invisible to any viewer,
live or not.

## Alternatives

- **Redis pub/sub for fan-out.** Rejected for this slice — BullMQ already
  runs on Redis in this repo, but adding a pub/sub channel on top is a
  second delivery mechanism for a need the outbox table (already the
  durable, replayable source of truth for every domain event) already
  satisfies once it can be scoped and polled cheaply. The one-poller,
  in-memory-fan-out design gets the same O(1)-connections property without
  a new piece of infrastructure.
- **Query param for the ticket instead of a URL path segment.** Rejected —
  the webhook route already established path-segment placement for exactly
  this "secret can't be a header" problem; matching it kept the redaction
  regex a near copy-paste and avoided a second convention for the same
  situation.
- **Leave `outbox_events.organisation_id` nullable to sidestep the
  backfill.** Rejected — every other tenant-owned table in this schema
  enforces NOT NULL, and the backfill turned out to be fully mechanical
  once every insert site's aggregate chain was traced (see Consequences).
- **Push the full computed resource through SSE instead of a thin
  notification.** Rejected — it would mean maintaining a second
  serialization path for every resource SSE ever needs to touch, and risks
  the SSE-carried value silently drifting from what a fresh GET would
  return. A notification that triggers a real refetch cannot drift.

## Consequences

- Campaign updates and forward-deployment health remain un-migrated to SSE
  — forward-deployment health still polls (`GET .../health`), matching ADR
  0006's own documented deviation from CLAUDE.md 17.4, and Campaign Detail
  has no live wiring yet. Both are the natural next slice once this
  plumbing has run against real traffic.
- `DomainEventType` (`packages/contracts/src/event.ts`) already contained an
  unrelated, unused `"backtest.completed"` member, confusingly close to the
  new `backtest_run.completed`. Grep-confirmed: `DomainEventType` is not
  imported or enforced anywhere in the repo — it has drifted from the real
  `eventType` strings the outbox actually routes on
  (`report_upload.*`, `backtest_run.*`, etc.) since before this change.
  `backtest_run.completed` follows the real, live convention; the enum is
  the stale one. Left unreconciled here — noted explicitly so a future
  cleanup of that enum doesn't silently break this event by "fixing" it
  into `backtest.completed`.
- A subscriber's catch-up read is capped at 200 rows (`SseHub`'s
  `POLL_BATCH_SIZE`) — a client that reconnects after a very long gap could
  miss events beyond that window. Acceptable for a first slice at current
  traffic; a follow-up would need to either raise the cap or paginate the
  catch-up read.
- `apps/worker-analytics/src/handlers.ts` gained its own local
  `resolveOrganisationId` helper, duplicating the one added to
  `apps/worker-backtest/src/handlers.ts` — deliberately not shared across
  packages/apps for a five-line query.
- `reply.raw.writeHead(...)` bypasses Fastify's reply pipeline entirely —
  including the point where `@fastify/cors` attaches its headers. A live
  browser smoke test caught this directly (integration tests call the
  service layer, never over real HTTP, so this gap was invisible to every
  test written for this slice): the stream route now reads the request's
  own `Origin` header and reflects it back explicitly, reproducing what
  `origin: true` on the cors plugin would have done automatically for a
  normal `reply.send()` response.

## Security implications

The SSE ticket is a bearer-equivalent credential for its 30-second window,
so it is scoped as narrowly as possible: single-use, short TTL, hashed at
rest (never the plaintext), redacted from every log line via the same
mechanism already proven for the webhook token, and validity-check-plus-burn
happens as one atomic step (`claimSseTicket`) so two requests racing the
same ticket can never both succeed. A leaked ticket exposes at most one
organisation's outbox notifications — thin
`{aggregateId, occurredAt}` shapes, never computed business data — for at
most 30 seconds if unused, or until the holder disconnects if it was
already claimed.

## Migration / rollback

Additive plus one backfill: `organisation_id` added to `outbox_events`
(NOT NULL after backfill, with a composite index) and a new `sse_tickets`
table (migration `0010`). Rolling back the feature itself means not
registering the two new routes and not rendering `LiveRunUpdates` — the
schema changes are harmless to leave in place, since every future outbox
insert already populates the column and nothing reads `sse_tickets` outside
the SSE routes themselves.
