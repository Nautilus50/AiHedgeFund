# Local setup

## Prerequisites

- Node 20+
- pnpm 9+
- Docker (for Postgres and Redis)
- A Clerk application (free tier is fine)
- An S3-compatible bucket — Cloudflare R2 is what this was developed against

## 1. Install

```bash
pnpm install
```

## 2. Start Postgres and Redis

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Both containers expose a healthcheck; wait for `healthy` before migrating:

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

## 3. Configure environment

Copy each `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
for w in worker-analytics worker-backtest worker-research worker-forward; do
  cp "apps/$w/.env.example" "apps/$w/.env"
done
```

### Clerk

From the Clerk dashboard, API Keys:

- `CLERK_SECRET_KEY` — `sk_test_…`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_PUBLISHABLE_KEY` — `pk_test_…`

**Organizations must be enabled** (Clerk dashboard → Configure →
Organizations). ARF-OS is organisation-scoped: a session without an
`org_id` claim is rejected by the API, by design. After enabling it, create an
organisation from the switcher in the app header.

### Object storage

From Cloudflare R2 → Manage API tokens → Create Account API token, with
**Object Read & Write** permission:

- `OBJECT_STORE_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`
- `OBJECT_STORE_BUCKET`
- `OBJECT_STORE_ACCESS_KEY_ID`
- `OBJECT_STORE_SECRET_ACCESS_KEY`
- `OBJECT_STORE_REGION` — `auto`

Scope the token to **this bucket only** rather than all buckets — the app
never touches another.

#### Bucket CORS policy — required, and easy to miss

Uploads go browser → object storage directly via a presigned URL
([ADR 0002](adr/0002-object-storage.md)), so the **browser** enforces CORS on
that request. Without a policy the upload fails with an opaque
`Failed to fetch`, while every test still passes — Node's `fetch` ignores
CORS, so the test suite cannot catch this.

In Cloudflare: R2 → your bucket → **Settings** → **CORS Policy** → Add:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Add each deployed origin to `AllowedOrigins` as it appears. Do not use `"*"` —
any site could then drive uploads with a leaked presigned URL.

This has to be done in the dashboard: an Object Read & Write token gets
`AccessDenied` on `PutBucketCors`.

## 4. Migrate

```bash
pnpm db:migrate
```

## 5. Link your Clerk identity to a local organisation

The API resolves a Clerk session to an internal organisation through
`organisations.clerk_organisation_id` and `users.external_auth_subject`. Until
a provisioning flow exists (see Known limitations), insert those links by
hand once — take the `org_…` and `user_…` ids from your Clerk dashboard:

```sql
INSERT INTO organisations (id, name, slug, clerk_organisation_id)
VALUES (gen_random_uuid(), 'My Org', 'my-org', 'org_...');

INSERT INTO users (id, external_auth_subject, email)
VALUES (gen_random_uuid(), 'user_...', 'you@example.com');

INSERT INTO memberships (id, organisation_id, user_id, role)
SELECT gen_random_uuid(), o.id, u.id, 'ADMIN'
FROM organisations o, users u
WHERE o.clerk_organisation_id = 'org_...'
  AND u.external_auth_subject = 'user_...';
```

## 6. Run

```bash
pnpm dev
```

Or individually:

```bash
pnpm --filter @arf-os/api dev              # http://localhost:4000
pnpm --filter @arf-os/web dev              # http://localhost:3000
pnpm --filter @arf-os/worker-backtest dev  # outbox relay
pnpm --filter @arf-os/worker-analytics dev # metrics + equity
```

The outbox relay must be running for any background work to flow — see
[ADR 0001](adr/0001-queue-technology.md).

## Verify the setup

```bash
./scripts/verify-credentials.sh
```

Checks that the object store is reachable, that its **CORS policy actually
permits a browser `PUT`** from your web origin, and that the Clerk secret is
accepted. Reports pass/fail only — never a credential value.

The CORS check issues a real preflight, so it catches the one misconfiguration
the test suite cannot. Override the origin it checks with `WEB_ORIGIN`:

```bash
WEB_ORIGIN=https://your-deployed-app.example ./scripts/verify-credentials.sh
```

## Testing

```bash
pnpm test              # unit — no infrastructure required
pnpm test:integration  # requires Postgres, Redis, and R2 credentials
pnpm test:e2e          # Playwright against the production build
```

Integration tests use a separate `arf_os_test` database so they never touch
development data. Create and migrate it once:

```bash
docker exec arf-os-dev-postgres-1 psql -U arf -d postgres -c 'CREATE DATABASE arf_os_test'
TEST_DATABASE_URL=postgres://arf:arf@localhost:5432/arf_os_test \
  DATABASE_URL=postgres://arf:arf@localhost:5432/arf_os_test pnpm db:migrate
```

Suites skip themselves when their infrastructure is unavailable, so
`pnpm test` stays green on a machine with no Docker.

For e2e, install the browser once:

```bash
pnpm --filter @arf-os/web exec playwright install chromium
```

## Full check

What CI should run, and what to run before calling work done:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
