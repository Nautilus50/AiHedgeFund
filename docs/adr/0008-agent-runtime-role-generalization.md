# ADR 0008: Agent runtime, slice 2 — versioned prompts, protected diagnostics, generalized role dispatch

## Status

Accepted — 2026-08-13. Implemented across `packages/contracts`,
`packages/db`, `packages/agent-runtime`, `packages/event-bus`,
`apps/worker-research`, `apps/api`, and `apps/web`'s Campaign Detail page.

## Context

CLAUDE.md §11 describes a real multi-agent runtime: versioned prompt
records (11.2), retained raw provider output in protected diagnostics
storage (11.3 steps 7-8), and a role-agnostic dispatch mechanism. What
existed before this slice was a single hardcoded path:
`apps/worker-research` rejected every role except the literal string
`"IDEA_SCOUT"`, the system prompt was a plain TypeScript string constant,
raw provider output was computed by `runStructuredAgent` and then discarded
on every call site, and nothing in the API ever enqueued the `agent-run`
job — the worker was reachable only by hand-constructing a BullMQ job in a
test.

`AgentRunJob.role` was also typed `z.string().min(1)` despite
`packages/contracts/src/enums.ts` already defining the full 11-member
`AgentRole` enum — the type safety this enum exists to provide was simply
never wired to the one place a role name crosses a queue boundary.

## Decision

Generalize the dispatch path and prove it with a second role,
`INDICATOR_RESEARCHER` (the next hop in the funnel per
`LEADER_AGENT_SYSTEM_PROMPT.md` §6.2), rather than continuing to special-case
IDEA_SCOUT. Concretely:

- **`AGENT_RUNTIME_REGISTRY`** (`packages/agent-runtime/src/registry.ts`) is
  the single source of truth for which roles this runtime can run —
  `Object.keys(AGENT_RUNTIME_REGISTRY)`, not a hardcoded list, backs both
  the fixture provider's dev outputs and the worker's dispatch, and now also
  the frontend's role dropdown and the API route's validation. Built with
  `satisfies`, not an explicit type annotation, so `keyof typeof
  AGENT_RUNTIME_REGISTRY` narrows to the two roles actually present rather
  than widening to all 11 `AgentRole` members.
- **`prompts` table** (`packages/db/src/schema/agent-runtime.ts`): real
  versioned records — role, semantic version, content, content hash, status
  (DRAFT/APPROVED/DEPRECATED), approver, approval time. A partial unique
  index (`role) WHERE status = 'APPROVED'`) makes "the APPROVED prompt for
  this role" well-defined rather than ambiguous. The worker hard-fails if no
  APPROVED row exists for a role — CLAUDE.md 11.2's "never load an
  unapproved challenger in production" is unconditional, a different
  failure class from 11.3 step 6's retry-then-fallback language, which is
  about output *validation* failures, not a missing prompt record. Shipped
  as a real migration (`0012_abnormal_christian_walker`) seeding both roles'
  prompts as `APPROVED` rows in every environment, not via
  `packages/db/src/seed.ts` — that script's own docstring says "never run
  against production," and a worker with no APPROVED prompt cannot run at
  all.
- **`agent_run_diagnostics` table**: the full raw `StructuredGenerationResult`
  (including a failed-then-retried attempt), written in the same
  transaction as the research task's terminal status update. Write-only
  this slice — see "Deferred" below for the read-access model this ADR
  settles without building.
- **Idempotency fix**: `handleAgentRun` now no-ops on redelivery of an
  already-`SUCCEEDED`/`FAILED_TERMINAL` task before doing any work. This was
  a real, pre-existing CLAUDE.md 3.6 gap (true for IDEA_SCOUT before this
  slice too, not introduced by it) — worth fixing here since a future real
  provider adapter would turn BullMQ's at-least-once redelivery into a
  duplicate model-API charge, not just a duplicate DB write.
- **`AgentRunJob.role`** now typed `AgentRole`, closing the type-safety gap
  described in Context.

## Alternatives considered

**Build a real LLM provider adapter this slice.** Rejected outright, not
deferred as a style choice: this dev environment has no
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` configured, so an adapter could be
written but never verified against a live API. Every other slice in this
project has been built and verified against real infrastructure (real
Postgres, real Redis, real R2) — shipping unverified network-integration
code would break that pattern, not extend it. `FixtureModelProvider` is
generalized instead, proving the dispatch/prompt/diagnostics machinery
works for more than one role without depending on credentials this session
doesn't have.

**Assemble `AgentHandoff` for the IDEA_SCOUT → INDICATOR_RESEARCHER
delegation.** `packages/contracts/src/agent-handoff.ts` already defines the
envelope, and §6.2 spec's INDICATOR_RESEARCHER as a real downstream
consumer of an idea. Deliberately not built here: IDEA_SCOUT's own output
today is written directly to `research_tasks.output`, bypassing the handoff
envelope entirely, and this slice keeps that same shape for
INDICATOR_RESEARCHER rather than introducing delegation chaining and role
generalization in the same change. Proving "any registered role can run
through this dispatch mechanism" and proving "one role's output can flow
into the next role's input via the handoff contract" are different claims;
this slice only makes the first one.

**Enforce a tool allowlist per role (CLAUDE.md 11.4).** Not built — no role
in this runtime calls any tool today (`runStructuredAgent` only ever
produces structured JSON from a prompt), so there is nothing yet for an
allowlist to gate. Revisit once a role actually needs tool access.

## Consequences

- Adding a third role means one entry in `AGENT_RUNTIME_REGISTRY` plus one
  seeded `prompts` row, not edits scattered across the worker and the
  fixture provider separately.
- `research_tasks.output`'s shape changed from IDEA_SCOUT-specific
  (`{ideaCard, ...}`) to generic (`{result, ...}`). Safe: no UI or service
  anywhere read that field before this slice (confirmed by search).
- **Remaining unbuilt roles: eight** — `STRATEGY_ARCHITECT, PINE_ENGINEER,
  BACKTEST_ENGINEER, ROBUSTNESS_VALIDATOR, FORWARD_TEST_OPERATOR,
  STRATEGY_JUDGE, DATA_INTEGRITY_ANALYST, PORTFOLIO_RESEARCHER` — plus
  `CHIEF_RESEARCH_ORCHESTRATOR`, the leader agent's own autonomous
  planning/delegation loop, called out separately because it is an entirely
  different scale of work (an orchestration loop that calls specialists),
  not just another role definition.
- The Indicator Researcher's protected-data boundary ("do not allow final
  holdout results," §6.2) is documented in
  `packages/agent-runtime/src/indicator-research.ts`'s docstring but not
  enforced in code — this repo has no final-holdout data model or
  protected-data gating for any role yet (confirmed by search: "holdout"
  appears nowhere in the schema).

## Security implications

**Protected diagnostics read-access model (decided, not built):** raw
provider output can reveal more than the schema-validated summary a
researcher is meant to see — CLAUDE.md 3.5's "never return protected
results through a general strategy endpoint without verifying role and
stage" applies here even though no read endpoint exists yet. The model:
reading `agent_run_diagnostics` would require a VALIDATOR/ADMIN-tier role
check (not RESEARCHER — the same tier the `research_tasks` write endpoint
gates at is not high enough for the raw output), and every read would write
an `audit_events` row (actor, aggregate, reason, trace ID — CLAUDE.md 9.4's
shape). No endpoint exposes this table yet; when one is built, it must
implement this model, not a looser one arrived at independently.

## Migration/rollback

Additive only: two new tables, one widened enum type on an existing column
(`AgentRunJob.role`), one new outbox routing case, one new API route, one
new frontend card. Rollback is dropping the new tables and reverting the
worker/registry changes — no existing data or behavior is altered.
