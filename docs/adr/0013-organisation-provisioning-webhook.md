# ADR 0013: Automatic organisation provisioning via a Clerk webhook

## Status

Accepted — 2026-08-17. Implemented across `packages/auth`, `packages/db`, and `apps/api`.

## Context

`packages/auth/src/context.ts`'s `resolveAuthContext` needs exactly three rows to succeed:
a `users` row keyed by Clerk's `external_auth_subject`, an `organisations` row keyed by
`clerk_organisation_id`, and a `memberships` row linking them with a role. Until those rows
exist, every request from a freshly-signed-up Clerk identity 401s with `UNKNOWN_USER`,
`UNKNOWN_ORGANISATION`, or `NOT_A_MEMBER_OF_ORGANISATION`. `docs/local-setup.md` closed that
gap with a one-off manual `INSERT` a human runs after signing up — a known limitation this
slice removes for anyone who configures the webhook, while keeping the manual step as a
documented fallback for anyone who hasn't.

## Decision

### One event, not three

`resolveAuthContext` doesn't care how its three rows got created — a webhook-driven insert is
a drop-in fix requiring zero changes to the auth plugin itself. Clerk offers separate
`organization.created`, `user.created`, and `organizationMembership.created` webhooks, but
their delivery order and timing relative to each other isn't guaranteed. Clerk's
`organizationMembership.created` payload (`OrganizationMembershipJSON`) embeds the full
`organization` object and a `public_user_data` object (`user_id`, `identifier`, `first_name`,
`last_name`) directly on the event — enough to provision all three rows from this one event
alone. `organization.created`/`user.created` are acknowledged (200, so Clerk doesn't retry them
forever) but not acted on — stated as intentional, not an oversight.

### No new `svix` dependency at the call site — `@clerk/backend` already ships webhook verification

`packages/auth` already depends on `@clerk/backend` for `verifyToken` (session JWTs).
`@clerk/backend/webhooks`'s `verifyWebhook(request, options)` wraps `svix` internally and is
exported from the same package — reusing it keeps the existing architectural rule intact
(`clerk-client.ts`'s own comment: "callers never import `@clerk/backend` directly," CLAUDE.md
11.1). `svix` itself still had to be added as a real dependency of `packages/auth` — despite
being listed as an *optional* peer dependency of `@clerk/backend`'s package.json, the compiled
`webhooks.mjs` unconditionally `import`s it, so `verifyWebhook` throws at runtime without it
actually installed. `apps/api` gains no new dependency; `verifyClerkWebhook` and the
`WebhookEvent`/`OrganizationMembershipJSON` types it needs are re-exported from
`packages/auth/src/clerk-client.ts`.

### Raw-body verification, scoped to one route only

Signature verification needs the exact bytes Clerk signed — Fastify's default JSON parser has
already transformed the body into an object by the time an ordinary route handler sees it.
`apps/api/src/plugins/webhooks-clerk.ts` is registered as its own encapsulated Fastify plugin
(`app.register(registerClerkWebhook, ...)`, not called directly), whose
`addContentTypeParser("application/json", { parseAs: "buffer" }, ...)` override therefore only
applies inside that plugin's own scope — every other route's body parsing is unaffected.

### Missing signing secret: 404, not a boot-time crash

Every other secret in `apps/api/src/server.ts` is `requireEnv()`'d — missing it crashes the
server at startup. `CLERK_WEBHOOK_SIGNING_SECRET` deliberately isn't: local dev has always
booted without ever touching Clerk's webhook dashboard config, and making this fatal would
break every existing setup that hasn't configured it yet, a bigger regression than "the new
automation isn't active." Without the secret, `POST /v1/webhooks/clerk` always 404s.

### Role assignment: the org's first member always gets ADMIN

Mapping Clerk's own role slug (`org:admin` → `ADMIN`, otherwise `RESEARCHER`, a deliberately
non-privileged default) is right for ongoing membership syncs, but wrong for a brand-new
organisation's very first membership: Clerk's org creator doesn't necessarily carry
`org:admin` on that first event in every signup flow, and if they don't, a solo signup would
land with `RESEARCHER` and *no* `ADMIN` in the org at all — recreating the exact
no-way-to-fix-it problem this feature exists to remove. `provisionFromMembershipEvent`
(`apps/api/src/services/provisioning.ts`) forces `ADMIN` when the `organisations` row was just
newly inserted in the same call, regardless of `event.role`; only subsequent members get the
role-slug mapping. This is a deliberate override, stated here because it's a judgment call, not
an obviously-correct default.

### Idempotency: check-then-insert, plus a unique-violation catch as a race backstop

This repo's established idempotency convention is check-then-insert with no `ON CONFLICT`
anywhere (`sweepHealthSnapshots`, ADR 0012, is the most recent example). This route deviates
slightly: every insert is additionally wrapped in a catch for Postgres's unique-violation code
(`23505`), re-reading the row that won the race instead of failing. Every other check-then-write
caller in this repo is operator- or event-bus-triggered, effectively single-writer per key;
this route is internet-facing and Clerk's own webhook delivery is at-least-once, so two
concurrent deliveries of the same event are a real, not theoretical, race — and a duplicate
`memberships` row would be a security-relevant outcome (double-granting a role), not just a
data-hygiene one. `memberships` also gained a new unique index on `(organisation_id, user_id)`
(`packages/db/src/schema/identity.ts`) it didn't have before, since the check-then-insert
pattern needs a real constraint to race against.

### Audit trail

Every successful provisioning writes one `audit_events` row (`actor: "clerk:webhook"`,
`action: "PROVISIONED"`, `aggregateType: "membership"`) inside the same transaction as the
insert — CLAUDE.md 9.4 requires an audit trail for state-changing writes, and "why does this
membership exist" is exactly the kind of question worth answering later for a row nobody
directly typed into existence.

## Alternatives considered

**Lazy provisioning on first authenticated request** (inline in the auth plugin, calling
Clerk's Backend API to fetch org/user details on a cache miss). Rejected — adds a network call
and a new failure mode to every request until the first successful provision, versus a webhook
that runs once, asynchronously, outside the request path.

**Reacting to `organization.created`/`user.created` as the load-bearing events instead of
`organizationMembership.created`.** Rejected — would require handling out-of-order delivery
(a membership event referencing an org/user row that doesn't exist yet) with either retries or
a deferred queue. The single-event approach sidesteps the ordering question entirely.

## Consequences

- Deletion events (`organization.deleted`, `user.deleted`, `organizationMembership.deleted`)
  are not handled. This repo has no soft-delete/archival concept for organisations, and their
  rows have real research history attached via foreign keys — hard-deleting on a Clerk-side
  deletion would be destructive in a way nothing else in this data model does. Left for a
  future slice that also designs what "an organisation's Clerk link was removed" should mean
  for its existing strategies/campaigns/decisions.
- `organization.updated`/`user.updated` (a renamed org, a changed email) are not synced either —
  `name`/`slug`/`email` are set once at provisioning time and not kept in sync afterward.
- Requires a publicly reachable URL for the webhook to actually fire, which local dev may not
  have without a tunnel — the manual SQL fallback in `docs/local-setup.md` remains fully
  correct and documented for that case.

## Security implications

The route is unauthenticated by necessity (Clerk cannot carry a session), secured instead by
`svix`/`@clerk/backend`'s HMAC signature verification over the raw request body — the same
authentication *shape* (signature/token over an unauthenticated endpoint, not a Bearer session)
already established for the TradingView webhook (ADR 0006), applied here via a provider's own
library instead of a hand-rolled scheme. `svix-signature` is never logged (Fastify's request
logger here only serializes method/url/hostname/remoteAddress/remotePort, confirmed in
`server.ts`; noted in `log-redaction.ts` for the next reader). A forged or replayed request
without a valid signature is rejected before any database write.

## Migration/rollback

Additive: one new unique index (`memberships_organisation_id_user_id_idx`), one new route, one
new service. Rollback means not registering the plugin and reverting to the manual-SQL-only
flow in `docs/local-setup.md`; already-provisioned rows are unaffected either way.
