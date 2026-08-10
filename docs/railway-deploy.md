# Deploying to Railway

This describes a deployment that was actually carried out, including the
things that went wrong. Read the [Traps](#traps) section before starting —
most of them cost real time to diagnose and are not obvious from Railway's
UI.

ARF-OS is a pnpm/Turborepo monorepo with six deployable apps. Railway has no
monorepo auto-detection worth relying on, so each app is its own Railway
**service** pointed at this same repo, with **Root Directory left at `/`**
(workspace packages under `packages/*` must be reachable at build time) and a
**Config File Path** pointing at its own file under `railway/`.

| App | Config file | Public networking | Notes |
|---|---|---|---|
| `apps/api` | `railway/api.json` | Yes | Has `/health`; already binds `0.0.0.0:$PORT` |
| `apps/web` | `railway/web.json` | Yes | Next.js; start command passes `-p $PORT` explicitly |
| `apps/worker-analytics` | `railway/worker-analytics.json` | No | BullMQ consumer |
| `apps/worker-research` | `railway/worker-research.json` | No | BullMQ consumer; see note on model providers below |
| `apps/worker-backtest` | `railway/worker-backtest.json` | No | Outbox relay — must always run or no background work flows |
| `apps/worker-forward` | `railway/worker-forward.json` | Yes (future webhook target) | **A stub.** Only `/health` exists; no TradingView ingestion route is implemented. Safe to deploy, does nothing useful yet. |

Plus two Railway-managed databases: **Postgres** and **Redis**.

## Before you start

Three external accounts, none of which Railway provides:

- **Clerk** — with Organizations enabled. See [Clerk instances](#clerk-instances)
  before deciding between Development and Production keys.
- **An S3-compatible bucket** — Cloudflare R2 is what this was developed
  against. You will also need dashboard access to set a CORS policy; an
  Object Read & Write API token cannot do it.
- **Node 20+ and pnpm 9** locally, plus the Railway CLI (`npm i -g @railway/cli`),
  for the migration and organisation-provisioning steps.

A model-provider API key is **not** required — see
[Model providers](#model-providers).

## 1. Create the project and services

1. Create a Railway project, then add a service per app: **New Service →
   Deploy from GitHub repo → this repo**.
2. For each service: set **Root Directory** to `/`, and set the
   **config-as-code path** to that app's file from the table above.
3. Note the names Railway assigns. It uses the **package name**, so services
   come out as `@arf-os/api`, `@arf-os/web`, `@arf-os/worker-analytics`, and
   so on — not `api`. Every CLI invocation needs the full name, quoted:

   ```bash
   railway variables --service "@arf-os/api" --kv
   ```

## 2. Add the databases

**+ New → Database → PostgreSQL**, then again for **Redis**. Leave both at
their default names (`Postgres`, `Redis`) — the `${{...}}` references below
resolve by service name.

Verify each one provisioned as a genuine managed database, not something
carrying dev defaults:

```bash
railway variables --service Postgres --kv | grep -E 'RAILWAY_PRIVATE_DOMAIN|DATABASE_URL'
```

A real managed Postgres shows a random password and a
`postgres.railway.internal` host. If you instead see
`postgres://arf:arf@localhost:5432/arf_os` — this repo's docker-compose
credentials — the service is wrong; delete it and add a fresh one, then read
[Duplicate databases](#duplicate-databases) before you do.

## 3. Set environment variables

**Use the CLI, not the dashboard.** Setting `${{...}}` references through the
UI proved unreliable in practice — edits appeared to save but the stored
value stayed stale. The CLI is unambiguous. Single-quote each pair so your
shell does not try to expand `${{`:

```bash
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --service "@arf-os/api" --skip-deploys
railway variable set 'REDIS_URL=${{Redis.REDIS_URL}}'          --service "@arf-os/api" --skip-deploys
```

Repeat for `@arf-os/worker-analytics`, `@arf-os/worker-backtest`, and
`@arf-os/worker-research`. Then confirm the resolved values:

```bash
railway variables --service "@arf-os/api" --kv | grep -E 'DATABASE_URL|REDIS_URL'
```

You want `postgres.railway.internal` and `redis.railway.internal`. Anything
mentioning `localhost` means the reference did not take.

### Per-service variables

**`@arf-os/api`** — `PORT` is injected by Railway; do not set it.

```
DATABASE_URL                    ${{Postgres.DATABASE_URL}}
REDIS_URL                       ${{Redis.REDIS_URL}}
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
OBJECT_STORE_ENDPOINT           https://<account-id>.r2.cloudflarestorage.com
OBJECT_STORE_BUCKET
OBJECT_STORE_ACCESS_KEY_ID
OBJECT_STORE_SECRET_ACCESS_KEY
OBJECT_STORE_REGION             auto
```

**`@arf-os/web`** — generate the `api` service's domain first, and include
the scheme with no trailing slash.

```
NEXT_PUBLIC_API_URL                 https://<api's Railway domain>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_SIGN_IN_URL       /sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL       /sign-up
```

**`@arf-os/worker-analytics`, `@arf-os/worker-backtest`, `@arf-os/worker-research`**

```
DATABASE_URL                 ${{Postgres.DATABASE_URL}}
REDIS_URL                    ${{Redis.REDIS_URL}}
LOG_LEVEL                    info
```

**`@arf-os/worker-forward`** — nothing beyond Railway's injected `PORT`.
It is a stub.

## 4. Deploy the API and generate domains

Deploy `@arf-os/api` first. `apps/api` calls `requireEnv()` at startup for
`DATABASE_URL`, `CLERK_SECRET_KEY`, `OBJECT_STORE_BUCKET`,
`OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_ACCESS_KEY_ID`, and
`OBJECT_STORE_SECRET_ACCESS_KEY`, so a missing variable fails loudly with
`Missing required environment variable: <NAME>` rather than starting
half-configured.

Generate public domains (**Settings → Networking → Generate Domain**) for
`api`, `web`, and `worker-forward`. The three workers need none.

## 5. Run migrations — in-network

Railway does not run migrations on deploy, and **you cannot run them from
your laptop against the default configuration**: `DATABASE_URL` points at
`postgres.railway.internal`, which resolves only inside Railway's private
network. `railway run` executes the command *locally*, so it inherits that
unreachable hostname.

The method that works, with no public database exposure:

1. Temporarily change `startCommand` in `railway/api.json` to:

   ```json
   "startCommand": "pnpm --filter @arf-os/db db:migrate"
   ```

   Remove `healthcheckPath` for this one deploy — a migration exits, so it
   will never answer a healthcheck.

2. Commit and push. Confirm a **new build** actually runs — see
   [watchPatterns](#watchpatterns-and-stale-config).

3. Watch the deploy logs for:

   ```
   Migrations applied successfully.
   ```

   Postgres `NOTICE` lines about identifiers being truncated (long foreign
   key names exceeding 63 characters) are expected and harmless.

4. Revert `railway/api.json` to the real start command and healthcheck, then
   push again. Do not leave it — the migrate command exits, so Railway's
   restart policy will loop it.

### The alternative: a public TCP proxy

If you would rather run migrations from your machine, enable a TCP proxy on
the Postgres service (**Settings → Networking**, under the external-client
option). That creates `DATABASE_PUBLIC_URL` pointing at
`<something>.proxy.rlwy.net:<port>`, reachable from anywhere.

```bash
cd packages/db && DATABASE_URL=$(railway variables --service Postgres --kv \
  | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-) pnpm db:migrate
```

This exposes your database to the internet with only the password protecting
it. **Remove the proxy when finished:**

```bash
railway tcp-proxy list --service Postgres
railway tcp-proxy delete <proxy-id> --yes
```

Afterwards `DATABASE_PUBLIC_URL` remains but resolves to an empty
host — `postgresql://postgres:...@:/railway` — which is how you can tell the
proxy is really gone.

## 6. Link a Clerk identity to an organisation

There is no self-serve provisioning flow. Until one exists, this is manual,
and until it is done every authenticated request returns
`401 Authentication required`.

`resolveAuthContext` (in `packages/auth`) requires **all four** of these:

| Requirement | Failure code if missing |
|---|---|
| Token carries an active organisation claim | `NO_ORGANISATION_IN_TOKEN` |
| `users` row matching the Clerk subject | `UNKNOWN_USER` |
| `organisations` row matching the Clerk org | `UNKNOWN_ORGANISATION` |
| `memberships` row joining the two | `NOT_A_MEMBER_OF_ORGANISATION` |

The first is easy to miss: a personal-account session has no org claim at
all, so it fails before the database is consulted. Create an organisation
from the switcher in the app header and make sure it is *actively selected*.

Collect the `org_...` and `user_...` IDs from the Clerk dashboard —
**copy them as text, do not transcribe them by eye.** Digit `0` and letter
`O` are visually identical in Clerk's monospace font, and a wrong character
produces exactly the same opaque 401.

Then run this SQL against the Railway database. It is safely re-runnable:
`memberships` has no unique constraint on `(organisation_id, user_id)`, so
the `NOT EXISTS` guard is what stops duplicate rows. Note also that the `id`
columns are `uuid` primary keys with **no default**, hence the explicit
`gen_random_uuid()` (built into Postgres 16, no extension needed).

```sql
INSERT INTO organisations (id, name, slug, clerk_organisation_id)
VALUES (gen_random_uuid(), 'My Organization', 'my-organization', 'org_…')
ON CONFLICT (clerk_organisation_id) DO NOTHING;

INSERT INTO users (id, external_auth_subject, email)
VALUES (gen_random_uuid(), 'user_…', 'you@example.com')
ON CONFLICT (external_auth_subject) DO NOTHING;

INSERT INTO memberships (id, organisation_id, user_id, role)
SELECT gen_random_uuid(), o.id, u.id, 'ADMIN'
FROM organisations o, users u
WHERE o.clerk_organisation_id = 'org_…'
  AND u.external_auth_subject = 'user_…'
  AND NOT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organisation_id = o.id AND m.user_id = u.id
  );
```

Verify exactly one row comes back:

```sql
SELECT u.email, o.name, m.role
FROM memberships m
JOIN users u ON u.id = m.user_id
JOIN organisations o ON o.id = m.organisation_id;
```

### Running that SQL without psql

`railway connect Postgres` opens a database shell but **requires `psql`
installed locally**, which it often is not. With a TCP proxy active, an
alternative that needs nothing beyond this repo's own dependencies is a
throwaway script in `packages/db/` (where the `postgres` driver already
resolves), run with `DATABASE_URL` set from `DATABASE_PUBLIC_URL`. Delete
the script afterwards so it does not get committed.

## 7. Object storage CORS

Browser uploads go straight to the bucket via a presigned URL, so the
**browser** enforces CORS on that request. Without a policy, uploads fail
with an opaque `Failed to fetch` while the entire test suite still
passes — Node's `fetch` ignores CORS, so no suite can catch this.

In Cloudflare: **R2 → your bucket → Settings → CORS Policy**. This must be
done in the dashboard; an Object Read & Write token gets `AccessDenied` on
`PutBucketCors`.

```json
[
  {
    "AllowedOrigins": [
      "https://<your-web-domain>",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Never use `"*"`: any site could then drive uploads with a leaked presigned
URL.

## 8. Verify

CORS is a bucket-level property, so this check is valid from anywhere — it
confirms the bucket accepts your *production* origin even when run locally.
It reads credentials from `apps/api/.env`.

```bash
WEB_ORIGIN=https://<your-web-domain> ./scripts/verify-credentials.sh
```

All three sections should report `OK`. If the first fails on credentials
that is your local `.env`, not the deployment; the CORS section is the one
that reflects bucket state.

Finally, load the web domain, sign in, and confirm the Command Centre lists
campaigns rather than showing `Authentication required`.

---

## Traps

### watchPatterns and stale config

Railway only re-reads a service's config file when something in that
service's `watchPatterns` changes. If `railway/<app>.json` is not itself
listed there, **editing it does nothing** — a new deployment appears in the
dashboard, and it silently runs the previous configuration. This is very
easy to misread as "my change did not save".

Every file under `railway/` now lists itself in its own `watchPatterns` to
prevent this. If you add a service, do the same.

To force a rebuild when you need one regardless, touch a file that *is*
watched — bumping the app's `package.json` version works, and is why
`apps/api` sits at `0.1.1`.

### Config-as-code beats the dashboard

With a config file path set, the dashboard's **Custom Start Command** field
is ignored. Editing it looks like it works and changes nothing. Change the
JSON file instead.

### Internal vs public hostnames

`*.railway.internal` resolves only inside Railway's private network. Your
laptop cannot reach it, and neither can `railway run`, which executes
locally despite pulling variables from Railway. This is the single most
confusing failure in the whole process, because the variable *looks*
correct.

### `railway run` and docker-compose

Because this repo contains `infra/docker/docker-compose.yml`, `railway run`
substitutes local development overrides — rewriting Postgres and Redis hosts
to `localhost` — and you get `ECONNREFUSED 127.0.0.1:5432` while the Railway
variable itself is fine. Pass `--no-local` to skip that behaviour.

### Duplicate databases

Deleting a database service and adding a replacement does **not** free the
name. Railway appends a suffix, so you end up with `Postgres` *and*
`Postgres-vQsL` both Online, both billing, while `${{Postgres.DATABASE_URL}}`
silently resolves to whichever service literally holds the name `Postgres`.

Audit with:

```bash
railway status
```

and confirm which instance your app really uses:

```bash
railway variables --service Postgres --kv | grep RAILWAY_PRIVATE_DOMAIN
```

### Volumes outlive their services

Deleting a database service leaves its volume provisioned and billing, shown
as `detached` in `railway status`. Reap them explicitly, checking suffixes
carefully — the live volume and the orphan differ by a few characters:

```bash
railway volume list
railway volume delete --volume <orphan-volume-name> --yes
```

### The pnpm version pin

`packageManager` must name a real pnpm release compatible with
`pnpm-lock.yaml` (currently `lockfileVersion: 9.0`, so a 9.x release). A
nonexistent version fails during install inside Nixpacks with a misleading
Node error:

```
TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.
```

That is corepack failing to resolve the pinned version, not a code problem.

### Clerk instances

A Clerk **Production** instance requires a domain you control DNS for, to
add CNAME records. A Railway-generated `*.up.railway.app` subdomain cannot
satisfy this — it is not yours. Until you have a custom domain, use
Development keys (`pk_test_…` / `sk_test_…`) and keep them consistent across
`api` and `web`. Add the deployed web origin to Clerk's allowed origins.

### Model providers

`MODEL_PROVIDER_API_KEY` appears in `.env.example` but **no code reads it**.
`apps/worker-research` always calls `createDevelopmentProvider()`, a fixture
provider returning canned `IdeaCard` responses. Setting a real key has no
effect, and no live model adapter exists yet — consistent with the README's
"Multi-agent runtime: Partial". Do not provision a key for this deployment.

## Cost hygiene

After any deletion or re-creation, confirm you are not paying for
leftovers:

```bash
railway status        # orphaned services, detached volumes
railway list          # abandoned projects from false starts
```

An abandoned project can quietly hold its own Postgres and Redis.
