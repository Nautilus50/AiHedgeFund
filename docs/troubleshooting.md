# Troubleshooting

Failures actually hit while building this, and what they mean.

## Auth

### Every `/v1` request returns 401 even though I am signed in

The session token has no `org_id` claim. ARF-OS rejects non-organisation
sessions by design.

- Enable Organizations in the Clerk dashboard (Configure → Organizations).
- Create and **select** an organisation using the switcher in the app header.
- Decode the token and confirm `org_id` is present:
  ```bash
  echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null | jq
  ```

### 401 with a valid, org-scoped token

The Clerk identity is not linked to a local organisation. The API resolves
through `organisations.clerk_organisation_id` and
`users.external_auth_subject`; if either row is missing you get
`UNKNOWN_ORGANISATION` or `UNKNOWN_USER`. See step 5 of
[local setup](local-setup.md).

### `Clerk: auth() was called but Clerk can't detect usage of clerkMiddleware()`

`middleware.ts` must sit at `apps/web/middleware.ts` (beside `app/`), and its
matcher must cover the route. If it is present and you still see this, you are
almost certainly hitting a **stale server** — see below.

### Signed-out visitors get a 404 instead of a sign-in page

Fixed, but the cause is worth knowing: `auth.protect()` needs an in-app
destination. Without a `/sign-in` route and an explicit `unauthenticatedUrl`,
Clerk rewrites to an internal path and the response surfaces as a bare 404.

## Stale servers

The single most misleading failure mode here. Next.js served from an old build
produces symptoms that look like code bugs — 404s on routes that exist,
middleware that seems not to run.

```bash
# find and stop them
pgrep -af "next-server|next start"
pgrep -f "next-server" | xargs -r kill
```

Playwright's `reuseExistingServer` is true outside CI, so a stale server on the
e2e port is silently reused. Kill it before running e2e after a rebuild.

> Careful with `pkill -f`: a pattern like `dist/index.js` also matches the
> shell wrapper running your command, so `pkill` kills its own parent. Match
> on `^node dist/index.js`, or use `pgrep` + `kill`.

## Database

### `ECONNREFUSED 127.0.0.1:5432`

Containers are not running. They do not survive a host restart unless
restarted explicitly:

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml ps   # wait for "healthy"
```

### `permission denied ... /var/run/docker.sock`

Your shell predates being added to the `docker` group. Either open a new
session, or prefix commands:

```bash
sg docker -c "docker compose -f infra/docker/docker-compose.yml ps"
```

### Integration tests fail with FK violations or duplicate slugs

Suites ran in parallel against the same test database and truncated each
other's fixtures. Run them through the root script, which pins
`--concurrency=1`:

```bash
pnpm test:integration      # correct
turbo run test:integration # will race
```

### Integration tests all skip

Expected when infrastructure is unavailable — suites skip rather than fail.
To actually run them, confirm `arf_os_test` exists and is migrated (step in
[local setup](local-setup.md)), and that `OBJECT_STORE_*` is set for the R2
ones.

## Background jobs

### Nothing happens after a state change

The outbox relay is not running. Nothing flows without it:

```bash
pnpm --filter @arf-os/worker-backtest dev
```

Check for stuck rows:

```sql
SELECT status, count(*) FROM outbox_events GROUP BY status;
```

- Rows stuck `PENDING` → relay is down.
- Rows stuck `PUBLISHING` → a relay died mid-flight. `reclaimStale()` returns
  them after 5 minutes.
- Rows `FAILED` → read the reason: `SELECT payload->>'relayError' FROM
  outbox_events WHERE status = 'FAILED';`

### `Custom Id cannot contain :`

BullMQ reserves `:` as its Redis key separator, so job ids must not contain
one. `deterministicJobId` uses `__`. If you add an id-building helper, keep it
`:`-free — a unit test with a fake publisher will not catch this.

## Object storage

### Browser upload fails with "Failed to fetch" (CORS)

The presigned URL is issued fine, but the browser's `PUT` straight to R2 is
blocked because the bucket has no CORS policy. Symptom: the API call to
`/uploads` returns 200, and the subsequent `PUT` throws `Failed to fetch`
with nothing useful in the console.

Node-based tests do **not** reproduce this — `fetch` in Node ignores CORS, so
the integration suite passes while the real UI fails. Only a browser catches it.

Fix it in the Cloudflare dashboard: R2 → your bucket → **Settings** → **CORS
Policy** → Add, with the minimum this flow needs:

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

Add the deployed origin alongside localhost when there is one. Do not use
`"*"` for origins — any site could then drive uploads with a leaked URL.

An Object Read & Write API token cannot set this (`AccessDenied` on
`GetBucketCors`/`PutBucketCors`); it requires dashboard access or an Admin
token.

### Uploads fail with 403

Presigned URLs expire after 15 minutes and are bound to one key *and* content
type. Confirm the `PUT` sends `Content-Type: text/csv`, matching what was
signed.

### Objects left in the bucket after tests

Tests clean up in `finally`, but an interrupted run can leak. Check and clear:

```bash
cd apps/api && node -e "
process.loadEnvFile();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const c = new S3Client({region:'auto',endpoint:process.env.OBJECT_STORE_ENDPOINT,
  credentials:{accessKeyId:process.env.OBJECT_STORE_ACCESS_KEY_ID,
  secretAccessKey:process.env.OBJECT_STORE_SECRET_ACCESS_KEY}});
c.send(new ListObjectsV2Command({Bucket:process.env.OBJECT_STORE_BUCKET}))
 .then(r => console.log(r.KeyCount ?? 0, (r.Contents ?? []).map(o => o.Key)));
"
```

## Build and tests

### `Module not found: Can't resolve './actions.js'` in apps/web

Next.js bundles with webpack, which does not want the `.js` extension on
relative TypeScript imports. Node-runtime packages (`packages/*`, `apps/api`,
workers) **do** need it — they are ESM. The rule differs by app on purpose.

### `Playwright Test did not expect test.describe() to be called here`

Vitest picked up a Playwright spec. `apps/web/vitest.config.ts` excludes
`e2e/**`; make sure new specs live there.

### `Please run: playwright install`

Browser binaries are per-Playwright-version:

```bash
pnpm --filter @arf-os/web exec playwright install chromium
```

### `exactOptionalPropertyTypes` errors on optional fields

The repo enables it, so `foo?: string` and `foo?: string | undefined` differ.
If you assign a possibly-undefined value to an optional property, declare it
as `?: T | undefined`.
