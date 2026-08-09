# Deploying to Railway

ARF-OS is a pnpm/Turborepo monorepo with six deployable apps. Railway has no
built-in monorepo auto-detection, so each app is its own Railway **service**
pointed at this same repo, with **Root Directory left at `/`** (workspace
packages under `packages/*` must be reachable at build time) and a
**Config File Path** pointing at its own file below.

| App | Config file | Public networking | Notes |
|---|---|---|---|
| `apps/api` | `railway/api.json` | Yes | Has `/health`; binds `0.0.0.0:$PORT` already |
| `apps/web` | `railway/web.json` | Yes | Next.js; start command passes `-p $PORT` explicitly |
| `apps/worker-analytics` | `railway/worker-analytics.json` | No | BullMQ consumer |
| `apps/worker-research` | `railway/worker-research.json` | No | BullMQ consumer; needs `MODEL_PROVIDER_API_KEY` |
| `apps/worker-backtest` | `railway/worker-backtest.json` | No | Outbox relay — must always be running for background work to flow |
| `apps/worker-forward` | `railway/worker-forward.json` | Yes (webhook target) | **Currently a stub** — only exposes `/health`, no TradingView ingestion route exists yet. Deploying it is safe but it won't do anything real until that's built. |

Plus two Railway-managed plugins: **Postgres** and **Redis**.

## Setup steps

1. Create a Railway project, add the **Postgres** and **Redis** plugins.
2. For each app in the table above: New Service → Deploy from GitHub repo →
   select this repo → set **Root Directory** to `/` → in service Settings,
   set **Config-as-code Path** to the file listed.
3. Set environment variables per service (see below). For `DATABASE_URL` and
   `REDIS_URL`, reference the plugins instead of copy-pasting values, e.g.
   `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`, so they stay in
   sync if the plugin ever rotates credentials.
4. Deploy `apps/api` first, then run migrations once against the Railway
   Postgres instance (`railway run --service api pnpm db:migrate`, or an
   equivalent one-off command) — Railway does not run migrations
   automatically on deploy.
5. Deploy the remaining services.
6. Complete the manual steps that are also required locally
   (see [`docs/local-setup.md`](./local-setup.md)):
   - Add the deployed web origin to the R2 bucket's CORS policy in the
     Cloudflare dashboard (an API token cannot set this itself).
   - Link the first Clerk organisation/user to internal rows by hand — no
     self-serve provisioning flow exists yet.

## Environment variables per service

**`apps/api`**
```
PORT                        (Railway sets this automatically)
DATABASE_URL                ${{Postgres.DATABASE_URL}}
REDIS_URL                   ${{Redis.REDIS_URL}}
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
OBJECT_STORE_ENDPOINT
OBJECT_STORE_BUCKET
OBJECT_STORE_ACCESS_KEY_ID
OBJECT_STORE_SECRET_ACCESS_KEY
OBJECT_STORE_REGION          (auto)
```

**`apps/web`**
```
NEXT_PUBLIC_API_URL          the api service's public Railway URL
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_SIGN_IN_URL   /sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL   /sign-up
```

**`apps/worker-analytics`, `apps/worker-backtest`**
```
DATABASE_URL                 ${{Postgres.DATABASE_URL}}
REDIS_URL                    ${{Redis.REDIS_URL}}
LOG_LEVEL                    info
```

**`apps/worker-research`**
```
DATABASE_URL                 ${{Postgres.DATABASE_URL}}
REDIS_URL                    ${{Redis.REDIS_URL}}
LOG_LEVEL                    info
MODEL_PROVIDER_API_KEY
```

**`apps/worker-forward`**

No required env vars beyond what Railway injects (`PORT`) — it's a stub
today; real config will follow once TradingView ingestion is implemented.

## Things to verify before relying on this

- Root `package.json` pins `"packageManager": "pnpm@11.20.0"`. Confirm that
  version is actually resolvable via corepack in Railway's Nixpacks build
  image before the first deploy — if not, the install step will fail and
  the version pin needs updating.
- Clerk keys here should be the **production** instance's keys, not the
  `sk_test_`/`pk_test_` pair used for local dev.
