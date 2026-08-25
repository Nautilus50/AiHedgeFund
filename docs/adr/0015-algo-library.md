# 0015 — Algo library

## Status

Accepted — 2026-08-25

## Context

ARF-OS models research in motion: campaigns, immutable strategy versions, validation gates,
TradingView parity, forward paper testing, committee decisions. What it has never modelled is the
output — the small set of algos that came through all of that and are actually worth running.

Today that set lives in the operator's head. Finding "the BTC momentum one we settled on" means
remembering which strategy version won, which backtest run backed it, and which Pine revision was
the tested one. The registry holds all of that, but nothing names the result.

An **algo library** is that missing layer: a private, organisation-scoped catalogue of finished
algos. Each entry has a stable name and slug, a current release pointing at one immutable strategy
version, evidence recomputed from that version's own trade ledger, and the Pine source to run —
with the hash it was tested at.

This is deliberately not a storefront. There is no anonymous surface, no pricing, no customers, no
payment processor, and no third-party developer programme. The library is for the organisation that
did the research.

## Decision

1. Introduce an algo-library domain in `packages/contracts` (`algo-library.ts`), `packages/db`
   (`schema/algo-library.ts`), and `apps/api` (`routes/algo-library.ts`,
   `services/algo-library/*`).
2. An **algo** belongs to exactly one organisation. Every read and write is scoped by
   `organisationId` inside the service, and no route accepts an organisation id from the request.
3. An algo holds no Pine source. Each **release** points at one immutable `strategy_version`, and
   the source is read through `pine_revisions`. A revision of an algo is a new release pointing at a
   new strategy version — algos inherit the immutability rule of CLAUDE.md 3.1 rather than working
   around it. Publishing a release supersedes the previous one in the same transaction, so there is
   never more than one current release.
4. **Evidence snapshots** are derived from a `backtest_run` or a `forward_deployment` by recomputing
   metrics through `packages/metrics` from the stored ledger — a run's trades directly, a
   deployment's paper fills paired into trades with the same `pairPaperFillsIntoTrades` the drift
   report uses — never by copying a runner- or paper-engine-reported summary. The evidence source is
   a discriminated union rather than a free `scope` field next to a free `sourceId`: a backtest run
   chooses between `IN_SAMPLE` and `OUT_OF_SAMPLE`, a forward deployment has no scope choice at all
   and is always `FORWARD_PAPER`, so mislabelling a source's scope has no valid request shape to
   begin with. Each snapshot records its scope, its source id, and the metric calculation version.
   The library may not display a number that has no snapshot row, and never merges scopes into one
   series (CLAUDE.md 18.1). A forward deployment must have actually run (`ACTIVE` / `PAUSED` /
   `COMPLETED`, not `PLANNED` / `FAILED` / `CANCELLED`) and have at least one closed round trip;
   republishing against the same deployment updates its snapshot in place as more trades close.
5. **Promotion gates** live in application code: a release requires a `PAPER_APPROVED` strategy
   version — the state that required a committee decision the strategy's own author could not make —
   and an existing Pine revision. An algo becomes `PUBLISHED` only with a published release and at
   least one evidence snapshot.
6. **Cataloguing is an operator action** (`OPERATOR` / `ADMIN`), separate from doing the research.
7. **Reading source is audited.** It is the one way code leaves the platform, so it writes an audit
   event naming the actor, the release and the source hash — never the source itself.

## Alternatives

- **A storefront with pricing, customers and entitlements.** Built first, then withdrawn: the
  platform is for personal use, and billing, subscriptions and a public catalogue were machinery
  with no purpose here. Removed in full rather than left dormant.
- **Add a `is_favourite` flag to `strategy_versions`.** Cheaper, but a favourite version is not an
  algo: it has no stable identity across revisions, no changelog, and nowhere to record which
  evidence is the published claim.
- **Copy the Pine source onto the algo at publish time.** Rejected: duplicating source creates a
  second, mutable truth and breaks lineage.
- **Let an operator type performance numbers in.** Rejected: unverifiable numbers are precisely what
  this platform exists to make hard.

## Consequences

- The research console gains a library section; the registry keeps working exactly as before.
- Retiring an algo hides it from the active library but deletes nothing — a line of work that was
  abandoned stays searchable, which is a stated goal of the system.
- The library is a read model with teeth: because it can only point at gated, immutable versions, it
  cannot drift from what the registry says was validated.

## Security implications

- Every query is organisation-scoped in the service layer; ownership is part of the lookup, not a
  check afterwards, so another organisation's algo simply does not resolve.
- Source reads write an audit event carrying the actor, release and hash, never the source body.
- The API gains no anonymous routes.

## Migration / rollback

- Additive migration only (`0016`); no existing table is altered or dropped.
- Rolling back means ceasing to register the library routes; nothing in the research pipeline
  depends on an algo-library table.
