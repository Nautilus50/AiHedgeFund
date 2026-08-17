# ADR 0010: Practice Arena, first slice — benchmark tasks, practice runs, human-graded scoring

## Status

Accepted — 2026-08-17. Implemented across `packages/db`, `packages/event-bus`,
`apps/worker-research`, `apps/api`, and `apps/web`'s new `/practice-arena` pages.

## Context

AI_RESEARCH_HEDGE_FUND_SPEC.md §10 (agent practice and self-improvement) and §15.13
(Practice Arena UI) describe a benchmark registry, blind practice tasks, deterministic +
model-graded scoring, automated champion/challenger comparison, human approval, lesson
records, and three memory scopes (reference/episodic/failure). Most of this needs a live LLM
— model-graded scoring needs a judge model, and meaningful champion/challenger comparison
needs real variance between runs a deterministic fixture provider can't produce (confirmed:
no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` exist in this dev environment, same constraint ADR
0008 documented). Memory scopes are a separate, large concern this slice doesn't touch.

What's genuinely buildable now, reusing the agent-runtime infrastructure ADR 0008 built: a
benchmark-task registry, running a task against any *specific* prompt version (not just the
currently-APPROVED one) through the same `runStructuredAgent`/`AGENT_RUNTIME_REGISTRY` path,
and **human-graded scoring** — the one dimension spec §10.4 lists ("Human-review score")
that's genuinely meaningful without a live model.

## Decision

### A separate `practice_runs` table, not a reuse of `research_tasks`

`research_tasks.campaignId` and `.role` are both `NOT NULL`, `campaignId` has a hard FK to
`campaigns` — confirmed by direct schema read. A practice/benchmark run cannot reuse that
table without a fake campaign row. This also independently satisfies CLAUDE.md 10.1
("production work is not the training set") — practice content structurally cannot land in
the same table real research does.

### Explicitly deferred: `prompts.status`/`benchmarkScore` promotion

`prompts.benchmarkScore`/`approvedBy`/`approvedAt` already exist, added by ADR 0008
specifically anticipating this slice — but this slice does **not** write to them, and does
not build a DRAFT→APPROVED promotion action. `prompts` has no `organisationId` — it's a
deliberate platform-wide table with a partial unique index enforcing at most one `APPROVED`
row per role, globally, across every organisation. This repo has no platform-admin role
concept anywhere: `packages/auth/src/rbac.ts`'s `hasRequiredRole` is a flat, org-scoped
allowlist check, and `OrganisationRole`'s `ADMIN` is itself scoped to one organisation's
membership. Gating a promotion action behind an org-scoped `ADMIN` check would let any one
organisation's admin approve a prompt affecting every organisation's agent runs
platform-wide — a real cross-tenant boundary mismatch, not something to paper over under
this slice's time pressure (CLAUDE.md 3.7: promotion gates live in deterministic application
code, not an expedient shortcut). This slice writes `humanReviewScore` only to the
`practice_runs` row, visible within the reviewing organisation. Resolving who is allowed to
promote a platform-wide prompt is a real, separate design decision, deliberately left open.

### `practice_runs.output` never contains raw provider output

Mirrors `research_tasks.output`'s exact shape (`{result, promptVersion, costUsd, provider}`
on success, `{reasonCode, issues}` on failure). `rawOutput` is never persisted anywhere for
practice runs — not stored, not logged. This is the honest reason there's no
`agent_run_diagnostics`-style sibling table for practice runs: there's nothing protected to
store for synthetic practice content, unlike real research output (which ADR 0008's
protected-diagnostics table exists specifically to hold, behind an access model still not
built). This slice does not reopen that boundary.

### `GET /v1/prompts?role=X` — the first-ever exposure of prompt content via API

Confirmed by search: zero existing routes read the `prompts` table before this slice — the
only consumer was the worker's internal `loadApprovedPrompt`. This route makes prompt content
readable, including `DRAFT` challenger content that may be someone's in-progress
prompt-engineering work, by any authenticated user of any organisation, platform-wide. This
is a deliberate decision on its own terms, consistent with `prompts` already being a
platform-shared table with no owning organisation to leak from — not an extension of an
existing convention, because there isn't one. A practice run needs to be able to test a
challenger prompt, not just the currently-approved one, so exposing `DRAFT` content is
required for the feature to do anything useful.

### `schemaValid`/`costUsd`/`latencyMs` are recorded, not scored

The dev `FixtureModelProvider` is deterministic and always schema-valid on every call — these
fields currently carry no signal and are not presented as "scores" anywhere in the UI. They
are recorded now so they become comparable the day a real provider adapter exists. Only
`humanReviewScore` is a real score this slice.

### Re-review is allowed, audited, not versioned

`POST /v1/practice-runs/:id/review` sets `humanReviewScore`/`humanReviewedByUserId`/
`humanReviewedAt`/`humanReviewNotes` directly on the `practice_runs` row, in one
`db.transaction()` together with an `auditEvents` insert (`aggregateType: "practice_run"`,
`priorStateSummary`/`newStateSummary` capturing the score before/after) — mirroring
`recordCommitteeDecision`'s own fix earlier this session: the workflow transition and its
decision record used to commit in two separate transactions, and a crash between them left an
approved/rejected strategy version with no decision explaining why. The same shape applies
here to the score write and its audit record. A second reviewer overwriting a first
reviewer's score is allowed rather than rejected with a conflict — the audit trail preserves
the prior score, so nothing is silently lost, and a full versioned-review-history table isn't
built this slice.

### A real BullMQ queue, not synchronous execution in the route handler

`practice_run.requested` routes to a new `practice-run` queue, consumed by a second `Worker`
registered in the same `apps/worker-research` process — not executed synchronously inside
`POST /v1/benchmark-tasks/:id/practice-runs`. `agent_run.requested`/`handleAgentRun` already
runs through BullMQ today under the identical condition (fixture provider, near-instant
completion), and that path's redelivery guard exists specifically because a future real
provider adapter would turn BullMQ's at-least-once redelivery into a duplicate model-API
charge, not just a duplicate DB write (ADR 0008). `handlePracticeRun` reuses that exact same
redelivery-guard shape. Running practice runs synchronously would mean rebuilding that
idempotency reasoning from scratch the day a real provider lands, instead of reusing
infrastructure that already has it.

## Alternatives considered

**Reuse `research_tasks` with a synthetic "practice" campaign.** Rejected — `campaignId` is
`NOT NULL` with a hard FK, and CLAUDE.md 10.1 explicitly wants practice content structurally
separate from production research, not just conventionally separate.

**Gate prompt promotion behind org-scoped ADMIN, accepting the cross-tenant risk as a known
limitation.** Rejected — see Decision above. A known limitation that lets one tenant affect
every other tenant's agent behavior is a security-boundary mismatch, not a documented gap.

**Execute practice runs synchronously in the API route.** Rejected — see Decision above;
would discard the redelivery-guard infrastructure ADR 0008 already built and proved out.

## Consequences

- Prompt promotion (DRAFT→APPROVED, populating `benchmarkScore`) remains unbuilt until a real
  platform-role concept exists. Until then, moving a prompt to APPROVED is a manual DB
  operation, same as it was before this slice (IDEA_SCOUT's original prompt was seeded via
  migration, not an app-level flow).
- Model-graded scoring, automated champion/challenger comparison, lesson records, and the
  three memory scopes (reference/episodic/failure) remain entirely unbuilt — this slice only
  proves the benchmark-task-registry and human-scoring mechanism works.
- `GET /v1/prompts` is broad (platform-wide, includes DRAFT content) by design — if prompt
  content is ever judged sensitive enough to restrict, this route is the one to revisit first.

## Security implications

`GET /v1/prompts` exposes prompt content — including in-progress DRAFT challengers — to any
authenticated user of any organisation. Accepted as consistent with `prompts` already being
platform-shared with no owning organisation (see Decision). `benchmark_tasks`/`practice_runs`
remain fully organisation-scoped with ownership joins on every read, matching every other
table in this repo — only `prompts` itself is the deliberate exception, and was already an
exception before this slice.

## Migration/rollback

New migration adds `benchmark_tasks`/`practice_runs` only — no changes to existing tables.
Rollback is deleting the new routes/services/worker handler/queue/tables; nothing else
depends on them.
