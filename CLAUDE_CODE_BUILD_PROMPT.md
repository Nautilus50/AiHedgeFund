# Claude Code Build Prompt

Copy this prompt into Claude Code at the root of the new repository.

---

You are the principal engineer responsible for building ARF-OS, a multi-agent systematic-strategy research operating system.

Before writing code, read these files in full:

1. `CLAUDE.md`
2. `AI_RESEARCH_HEDGE_FUND_SPEC.md`
3. `LEADER_AGENT_SYSTEM_PROMPT.md`
4. `SPECIALIST_AGENT_PROMPTS.md`
5. Every schema in `schemas/`

Treat `CLAUDE.md` as the repository engineering policy and `AI_RESEARCH_HEDGE_FUND_SPEC.md` as the product specification.

## Objective

Build the first production-quality vertical slice of ARF-OS.

The vertical slice must allow an authenticated user to:

1. Create an organisation-scoped research campaign.
2. Create or ingest a structured Idea Card.
3. create a Strategy and immutable Strategy Version.
4. Store and validate a Strategy Definition Language document.
5. Store an immutable Pine Script v6 revision and manifest.
6. Create a TradingView verification task.
7. Upload TradingView Performance Summary and List of Trades CSV files.
8. Parse and preserve the raw files.
9. Reconstruct the trade ledger, equity curve, and drawdown curve.
10. Compute versioned core metrics independently.
11. Display Campaign, Strategy Library, and Strategy Detail screens.
12. Create an audited decision of `REJECT`, `REWORK_WITH_NEW_VERSION`, or `PAPER_APPROVED`.
13. Show complete lineage, artefact identity, and audit history.

Do not implement live trading.

Do not implement unsupported TradingView browser automation.

Do not use fake data outside tests and explicit development fixtures.

## Required stack

Use the repository-pinned stable versions of:

- TypeScript
- pnpm workspaces
- Turborepo
- Next.js App Router
- Fastify
- PostgreSQL
- Drizzle ORM
- Redis and BullMQ
- Zod
- Clerk
- S3-compatible object storage
- Vitest
- Playwright
- OpenTelemetry-compatible instrumentation

If the repository is empty, initialise the monorepo according to `CLAUDE.md`.

## Required applications

Create:

- `apps/web`
- `apps/api`
- `apps/worker-research`
- `apps/worker-backtest`
- `apps/worker-analytics`
- `apps/worker-forward`

For this milestone, worker-forward may contain only a health endpoint and placeholder domain package wiring. Do not add live order routing.

## Required packages

Create:

- `packages/contracts`
- `packages/db`
- `packages/workflow`
- `packages/agent-runtime`
- `packages/pine`
- `packages/backtest-sdk`
- `packages/metrics`
- `packages/event-bus`
- `packages/auth`
- `packages/observability`
- `packages/ui`

Keep package APIs small and explicit.

## Architecture requirements

### Immutable strategy versions

A tested strategy version cannot be edited.

Create a child version for every material change.

The database must enforce identity and lineage relationships.

### Workflow authority

All lifecycle transitions go through `packages/workflow`.

Workers cannot update lifecycle state directly.

### Audit

State transitions, protected artefact access, decisions, uploads, and human overrides create append-only audit records.

### Idempotency

Support idempotency for:

- campaign creation,
- strategy-version creation,
- report upload completion,
- parse jobs,
- decisions.

### Structured contracts

Use Zod schemas at every boundary.

Generate TypeScript contracts corresponding to the JSON schemas in `schemas/`.

### Object storage

Preserve raw TradingView uploads by checksum.

Store derived parse outputs separately.

### TradingView ingestion

Implement versioned parsers.

The parser must:

- identify report type,
- handle CSV delimiters safely,
- detect ambiguous number/date locale,
- preserve raw rows,
- return warnings,
- reject unknown required columns rather than guessing.

Create development fixtures for at least two export variants.

### Independent metrics

At minimum compute:

- closed trade count,
- gross profit,
- gross loss,
- net profit,
- profit factor,
- win rate,
- average win,
- average loss,
- payoff ratio,
- maximum drawdown,
- maximum drawdown percentage,
- longest losing streak,
- average holding duration where timestamps permit,
- monthly return series.

Every metric stores a calculation version and unit.

### Equity reconstruction

Reconstruct equity from the parsed trade ledger using the declared initial capital and costs.

Do not read values from screenshots.

Keep TradingView-reported metrics and ARF independently calculated metrics separately so parity can be evaluated.

### Parity

Create a basic parity report comparing:

- trade count,
- net profit,
- reported max drawdown where available,
- first and last trade,
- source/settings identity.

The report may be `PASS`, `WARN`, `FAIL`, or `INSUFFICIENT_DATA`.

## Database entities for this milestone

Implement at least:

- organisations
- users or external auth subjects
- memberships
- campaigns
- research_tasks
- strategies
- strategy_versions
- strategy_lineage
- strategy_definitions
- pine_revisions
- artefacts
- tradingview_verifications
- report_uploads
- backtest_runs
- trades
- equity_points
- drawdown_points
- metric_snapshots
- parity_reports
- committee_decisions
- audit_events
- outbox_events
- idempotency_records

Use UUIDv7-compatible IDs.

Use UTC timestamps.

Use numeric/decimal database types for money.

## Workflow states for this milestone

Implement:

- `CAMPAIGN_BACKLOG`
- `IDEA_RESEARCH`
- `HYPOTHESIS_DRAFT`
- `PINE_DEVELOPMENT`
- `TRADINGVIEW_VERIFICATION`
- `PAPER_APPROVAL_REVIEW`
- `PAPER_APPROVED`
- `REJECTED`
- `BLOCKED`

Transitions require typed evidence and role checks.

## API endpoints for this milestone

Implement versioned endpoints for:

- campaigns
- strategies
- strategy versions
- SDL upload/read
- Pine revision upload/read
- TradingView verification creation
- presigned report uploads
- report-upload completion
- verification status
- trades
- equity
- metrics
- parity
- decisions
- audit timeline

Use cursor pagination for lists.

Use problem-details responses.

Use an `Idempotency-Key` header for commands.

## Frontend screens for this milestone

### Command Centre

Show:

- campaign counts,
- strategy funnel,
- pending TradingView verifications,
- jobs,
- recent decisions,
- data/parse failures.

### Campaign Detail

Show:

- campaign summary,
- task/state timeline,
- strategies,
- audit.

### Strategy Library

Provide filters for:

- state,
- market,
- timeframe,
- evidence/parity status,
- date.

### Strategy Detail

Tabs:

- Evidence summary
- SDL
- Pine source and manifest
- TradingView verification
- Trades
- Equity and drawdown
- Metrics
- Lineage
- Decisions
- Audit

### Verification Upload

Show exact required:

- strategy version,
- Pine hash,
- symbol,
- timeframe,
- settings,
- report types.

Support drag-and-drop or file selection through presigned upload.

### Decision

Show:

- exact strategy version,
- evidence completeness,
- parity,
- core metrics,
- warnings,
- rejection case field,
- decision form.

Do not permit `PAPER_APPROVED` when required verification evidence is missing or parity is `FAIL`.

## UI rules

- Desktop-first.
- Clear historical/simulated labels.
- No claim of future profitability.
- Read-only tested Pine revisions.
- Accessible chart summaries.
- Loading, empty, stale, and error states.
- Every metric links to scope/run.
- Never merge TradingView-reported and independently calculated values into one unlabeled number.

## Background jobs

Use BullMQ.

Implement jobs for:

- report parse,
- trade normalisation,
- metric calculation,
- equity reconstruction,
- parity calculation,
- read-model refresh.

Jobs must be idempotent and restart-safe.

Use the transactional outbox pattern for reliable event publication.

## Agent runtime in this milestone

Implement the role/task/prompt storage and structured-run interfaces, but only fully wire one minimal path:

- Create an Idea Card through the `IDEA_SCOUT` role using a provider adapter or a deterministic fixture provider in development.

Do not let the model transition workflow state.

Validate output and store the agent run, artefact, handoff, cost, and prompt version.

Keep model providers behind an interface.

## Security

- Organisation-scope every query.
- Never trust client-supplied organisation IDs without membership checks.
- Use presigned uploads.
- Sanitize rendered markdown.
- Never log secrets, full provider prompts containing protected data, or raw auth tokens.
- Audit protected artefact reads.
- Rate limit upload-completion and decision endpoints.
- Do not send TradingView exports to a model.

## Testing

Write:

### Unit tests

- contracts
- workflow transitions
- CSV parsing
- decimal metrics
- equity reconstruction
- drawdown
- parity
- idempotency
- Pine manifest hashing

### Integration tests

- PostgreSQL repositories
- transition plus audit transaction
- outbox
- BullMQ job retry
- upload completion to parsed result
- organisation access isolation

### End-to-end tests

1. Login/dev auth
2. Create campaign
3. Create strategy and version
4. Add SDL and Pine revision
5. Create verification
6. Upload fixture reports
7. Wait for processing
8. View trades/equity/metrics
9. Make a decision
10. Verify audit timeline

## Delivery method

Work in coherent milestones:

1. Repository and tooling
2. Contracts
3. Database
4. Auth and organisation boundary
5. Workflow and audit
6. Strategy registry
7. Object storage and verification uploads
8. Report parsing
9. Metrics/equity/parity
10. API
11. Frontend
12. Worker integration
13. Tests
14. Documentation and local setup

After each milestone:

- run focused tests,
- update progress documentation,
- keep the repository buildable.

## Required documentation

Create:

- `README.md` with local setup
- `.env.example`
- architecture diagram
- database overview
- report parser documentation
- fixture documentation
- ADRs for queue, storage, workflow, and TradingView verification
- API examples
- troubleshooting guide

## Completion checks

Before declaring the vertical slice complete, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

Report:

- implemented features,
- architecture decisions,
- migrations,
- endpoints,
- screens,
- tests run,
- known limitations,
- next recommended milestone.

## Final instruction

Build the evidence system first.

Do not spend the initial milestone creating many autonomous agents or a beautiful but ungrounded dashboard.

The vertical slice is successful when one real Pine strategy can be stored immutably, verified from TradingView exports, independently analysed, displayed with equity and drawdown, and given an audited decision.
