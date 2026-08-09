# ADR 0003: A first-party workflow state machine, not a framework

## Status

Accepted — 2026-08-08. Implemented in Milestone 5.

## Context

The research lifecycle is the product. CLAUDE.md 10 requires a single place
that owns allowed transitions, required evidence, required role, human
approval, hard-fail checks, policy version, and decision records — and
explicitly forbids scattering transition checks across route handlers.
CLAUDE.md 4 adds: "The agent orchestration state machine belongs to ARF-OS. Do
not hide it inside a third-party agent framework."

Separation of duties is a correctness requirement, not a nicety: the agent
that creates a strategy version must not be able to approve it (CLAUDE.md 3.4).

## Decision

Implement the state machine in `packages/workflow` as first-party code, with
three deliberately separated layers:

- **`policy.ts`** — a flat, explicit table of allowed `from -> to` edges, each
  carrying its required role, whether evidence is mandatory, and whether the
  creator is barred from acting. Flat rather than generic so every rule is
  visible in one screen.
- **`evaluate-transition.ts`** — a pure function over that table. No I/O, so
  every policy rule is unit-testable without a database.
- **`service.ts` + a repository port** — orchestration and persistence. The
  Drizzle adapter writes the state change, the audit event, and the outbox
  event in one transaction (CLAUDE.md 9.3).

Expected policy rejections return a typed failure result; they do not throw.
Throwing is reserved for genuine faults.

Idempotency is checked **before** policy evaluation. A retried request must
replay its stored result rather than being re-validated against a state the
first call already advanced past — otherwise a legitimate retry looks like an
illegal transition.

## Alternatives

- **Temporal / Step Functions / a BPM engine.** Real durability and retry
  semantics, but it would move the lifecycle rules — the thing this product
  exists to enforce — into someone else's runtime, against CLAUDE.md 4.
- **XState or a generic state-chart library.** Reasonable, but the value here
  is the *policy metadata* attached to each edge (role, evidence, creator
  bar), not graph traversal. A table expresses that more directly.
- **Transition checks inside route handlers.** Explicitly forbidden by
  CLAUDE.md 10, and it would make separation of duties unauditable.

## Consequences

- Adding a lifecycle state means editing one table, and the compiler finds
  every switch that must handle it.
- The workflow package has no scheduling or timer support. Anything
  time-triggered (e.g. forward-test expiry) needs a separate mechanism.
- `strategy_versions` records the creating *agent run*, not an actor id, so
  the creator-cannot-approve check currently compares against the run id as a
  stand-in. Tightening this is pending the agent-run tables in a later phase.
- Because policy is pure, the expensive integration tests only need to cover
  persistence and atomicity, not the rule matrix.

## Security implications

- Role checks and the creator bar live in deterministic code, never in a
  prompt (CLAUDE.md 3.7 — "A model recommendation is evidence, not
  authority").
- Every transition writes an append-only audit row carrying actor, prior
  state, new state, reason, and policy version.
- `ADMIN` bypasses role checks by design; there is no bypass for the creator
  bar, which is the separation-of-duties invariant.

## Migration / rollback

`POLICY_VERSION` is stamped on every transition record, so decisions made
under an older rule set remain interpretable after the table changes. Changing
an existing edge's role or evidence requirement should bump it.
