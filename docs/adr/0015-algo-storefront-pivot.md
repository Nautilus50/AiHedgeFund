# 0015 — Algo storefront pivot (Quantlane)

## Status

Accepted — 2026-08-25

## Context

ARF-OS was built as an internal, organisation-scoped research operating system: campaigns,
immutable strategy versions, validation gates, TradingView parity, forward paper testing and a
committee decision trail. It has no commercial surface — there is no way for a person outside the
operating organisation to see a strategy, pay for it, or receive its Pine source.

The product direction has changed. The customer-facing product is a **plug-and-play algo
storefront** in the mould of ProRealAlgos: a public catalogue of trading algos, each with a
labelled track record, sold as per-algo monthly subscriptions with volume discounts, delivered as
Pine Script v6 source to entitled subscribers, and open to third-party developers who submit
algos and earn a revenue share.

The research machinery is not discarded. It becomes the **admin back-office**: the only way an
algo reaches the catalogue is by being promoted from an immutable, validated `strategy_version`.
Published performance numbers therefore stay traceable to a real backtest run or forward
deployment, which is the property the whole platform exists to protect.

## Decision

1. Introduce a storefront domain in `packages/contracts` (`storefront.ts`), `packages/db`
   (`schema/storefront.ts`), and `apps/api` (`routes/storefront/*`, `services/storefront/*`).
2. A **storefront** is a public face for exactly one organisation, addressed by slug. Public
   endpoints resolve the storefront by slug and may only read listings belonging to that
   storefront's organisation. There is no "list every published listing" query.
3. An **algo listing** is the commercial object. It never holds Pine source. Each **release**
   points at one immutable `strategy_version`; the source is read through `pine_revisions`. A new
   revision of an algo is a new release pointing at a new strategy version — listings inherit the
   immutability rule of CLAUDE.md 3.1 rather than working around it.
4. **Published statistics** are snapshots derived from a `backtest_run`, a `forward_deployment`,
   or approved customer statements. Each snapshot records its scope
   (`IN_SAMPLE` / `OUT_OF_SAMPLE` / `FORWARD_PAPER` / `CUSTOMER_VERIFIED`), its source id, and the
   metric calculation version. The catalogue may not display a number that has no snapshot row,
   and never merges scopes into one series (CLAUDE.md 18.1).
5. **Customers are users without an organisation membership.** The existing `AuthContext` stays
   organisation-scoped for the research console; a parallel `CustomerContext` (user id only)
   authenticates storefront buyers. The two are resolved separately and never substitute for one
   another.
6. **Billing** goes through a `BillingProvider` interface with a Stripe adapter and an in-memory
   adapter used by tests. Provider webhooks are the only writer of subscription state; every
   webhook delivery is recorded by `provider_event_id` and processed at most once.
7. **Entitlement is the single gate for source delivery.** One row per (customer, listing). Source
   reads are audited as protected-data reads (CLAUDE.md 3.5).
8. **Pricing** is per-listing monthly amounts in integer minor currency units, with storefront-wide
   volume discount tiers expressed in basis points. No floating point touches an authoritative
   total (CLAUDE.md 7.4).
9. **Developer submissions** enter through the same validation gates as internal work; approval is
   an admin action that creates a listing with a revenue-share basis-point setting.

## Alternatives

- **Separate repository / greenfield storefront.** Rejected: the storefront's core promise is that
  published numbers are traceable, which requires living next to the registry that produces them.
- **Copy Pine source into the listing at publish time.** Rejected: duplicating source creates a
  second, mutable truth and breaks lineage.
- **Sell tiered plans instead of per-algo subscriptions.** Simpler entitlement, but does not match
  the chosen commercial model (per-algo with volume discounts).
- **Let admins type performance numbers in.** Rejected: unverifiable marketing claims are precisely
  what this platform is supposed to make hard.

## Consequences

- The API now serves anonymous traffic for the first time. Public routes are read-only, rate
  limited, and scoped to one storefront's published rows.
- The web app gains a public surface; `middleware.ts` is no longer "everything requires auth".
- The research console remains intact and unchanged in behaviour.
- Money handling, tax and refunds enter the codebase's risk surface.

## Security implications

- Anonymous read paths must never expose Pine source, draft listings, another storefront's rows,
  customer identities, or unpublished statistics.
- Stripe webhook signatures are verified before any state change; unverified deliveries are dropped
  and counted, never processed.
- Stripe secret keys and webhook secrets are server-side only and never logged (CLAUDE.md 19).
- Source delivery writes an audit event with the customer, listing, release and trace id.
- Customer-uploaded broker statements are untrusted files: checked type/size, stored under a
  storefront-scoped object prefix, never rendered as HTML.

## Migration / rollback

- Additive migration only; no existing table is altered or dropped.
- Rolling back means ceasing to register the storefront routes and hiding the public web surface;
  the research console does not depend on any storefront table.
