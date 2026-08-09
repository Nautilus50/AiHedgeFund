# Database overview

PostgreSQL is authoritative for identity, workflow state, the strategy
registry, decisions, audit, and job references. Large immutable artefacts live
in object storage, referenced by `artefacts.object_key` (CLAUDE.md 9.1).

Schema lives in `packages/db/src/schema/`, migrations in
`packages/db/drizzle/`. All ids are UUIDv7-compatible; all timestamps are
`timestamptz` in UTC; all money uses `numeric`, never floating point
(CLAUDE.md 7.4).

## Identity and tenancy

| Table | Notes |
|---|---|
| `organisations` | `clerk_organisation_id` links a Clerk org to an internal one |
| `users` | `external_auth_subject` is the Clerk `sub`; the internal `id` is ours |
| `memberships` | Organisation-scoped role assignment |

Every aggregate read verifies organisation ownership. Tables that do not carry
`organisation_id` directly (`strategy_versions`, `tradingview_verifications`)
are reached by joining through `strategies`.

## Research and registry

| Table | Notes |
|---|---|
| `campaigns` | Organisation-scoped research campaign |
| `research_tasks` | Agent task record and structured output |
| `strategies` | Conceptual lineage root |
| `strategy_versions` | **Immutable.** Any material change creates a new row |
| `strategy_lineage` | Parent edges with change category and motivating evidence |
| `strategy_definitions` | SDL document, unique per version |
| `pine_revisions` | Pine source + manifest, unique per version |

The uniqueness constraints on `strategy_definitions.strategy_version_id` and
`pine_revisions.strategy_version_id` are what make immutability a database
invariant rather than a convention: a second write for the same version fails
at the constraint instead of silently overwriting tested evidence
(CLAUDE.md 3.1).

## Verification and evidence

| Table | Notes |
|---|---|
| `artefacts` | Object-store pointer with server-computed `checksum_sha256` |
| `tradingview_verifications` | Human-assisted verification task |
| `report_uploads` | Per-file parse status, parser version, warnings |
| `backtest_runs` | Run identity: runner, version, symbol, window, cost model |
| `trades` | Reconstructed trade ledger |
| `equity_points` / `drawdown_points` | Reconstructed curves |
| `metric_snapshots` | One row per metric, with unit and calculation version |
| `parity_reports` | Local vs TradingView comparison (schema only so far) |

`metric_snapshots` deliberately stores one row per metric rather than a wide
table, so a calculation-version change can coexist with historical values
instead of overwriting them.

## Governance

| Table | Notes |
|---|---|
| `committee_decisions` | Decision, reason codes, both cases, override flag |
| `audit_events` | **Append-only through the application.** No update path is written |

## System

| Table | Notes |
|---|---|
| `outbox_events` | Transactional outbox — `PENDING` → `PUBLISHING` → `PUBLISHED`/`FAILED` |
| `idempotency_records` | Key → request fingerprint → stored response |

`PUBLISHING` exists because without it a relay's `FOR UPDATE SKIP LOCKED`
claim would release at commit, letting a second relay re-claim rows still in
flight. See [ADR 0001](adr/0001-queue-technology.md).

`idempotency_records.request_hash` stores a canonical fingerprint (sorted
keys, `undefined` dropped), so replaying a logically identical request is
recognised regardless of JSON key order, while a genuinely different body
under the same key is rejected (spec 14.11).

## Transactional boundaries

These must commit atomically (CLAUDE.md 9.3), and each is covered by an
integration test:

- state transition + audit event + outbox event
- artefact + report upload
- strategy version + lineage
- committee decision + status change

## Migrations

```bash
pnpm db:generate   # after editing schema
pnpm db:migrate
```

Never edit an applied migration. Destructive changes require an ADR
(CLAUDE.md 9.2).

| Migration | Change |
|---|---|
| `0000_tranquil_madelyne_pryor` | Initial 23-table schema |
| `0001_melted_gressill` | `organisations.clerk_organisation_id` |
| `0002_swift_jetstream` | `outbox_status` gains `PUBLISHING` |

## Indexes

None beyond primary keys and unique constraints have been added yet.
CLAUDE.md 9.2 says to index real query patterns rather than speculation — the
patterns worth indexing (organisation-scoped listings ordered by
`created_at, id`; outbox claims filtered on `status`) are known but have not
been measured under load. This is deliberate, and is listed under Known
limitations in the README.
