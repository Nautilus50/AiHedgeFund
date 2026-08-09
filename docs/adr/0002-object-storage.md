# ADR 0002: S3-compatible object storage (Cloudflare R2) with presigned uploads

## Status

Accepted — 2026-08-08. Implemented in Milestone 7.

## Context

TradingView exports are the MVP's primary evidence. CLAUDE.md 9.1 makes
PostgreSQL authoritative for identity and workflow state, and object storage
authoritative for large immutable artefacts — raw CSVs, Pine bundles, reports.
CLAUDE.md 15.1 additionally requires presigned uploads and checksum
preservation of the raw file.

The important constraint is evidential, not technical: the raw upload must
survive unchanged, and its checksum must be one *we* computed, not one the
client asserted. A parser that later rejects the file must not cost us the
artefact.

## Decision

Use **S3-compatible object storage**, configured against **Cloudflare R2** in
development, accessed through `@aws-sdk/client-s3`.

Uploads are two-step:

1. `createReportUploadIntent` returns a presigned `PUT` URL. No database row
   is written yet — at this point we do not know the file's checksum or size,
   and CLAUDE.md 15.1 forbids trusting a client-declared value.
2. `completeReportUpload` fetches the object back, recomputes SHA-256 over the
   actual bytes, persists the `artefacts` and `report_uploads` rows, and only
   then attempts to parse.

File bytes never pass through the API process.

Object keys follow spec 14.7:

```
orgs/{orgId}/campaigns/{campaignId}/strategies/{strategyId}/versions/{versionId}/{category}/{categoryId}/{filename}
```

Every path component is derived server-side from the verification row's own
join chain, never from the request body, so a caller cannot craft a key that
lands in another tenant's prefix.

## Alternatives

- **Proxy uploads through the API.** Simpler to reason about, but puts large
  file bodies through the request path and burns application memory and
  bandwidth for no evidential gain.
- **Store CSVs in PostgreSQL as bytea.** Keeps one datastore and gives
  transactional writes. Rejected: these are large immutable blobs, exactly
  what CLAUDE.md 9.1 says belongs in object storage, and it would bloat
  backups of the workflow-critical database.
- **AWS S3 directly.** Equivalent API. R2 chosen for development because it
  has no egress fees and a usable free tier; the code targets the S3 API, so
  switching is configuration, not code.

## Consequences

- The upload flow is not atomic end to end: a client can obtain a presigned
  URL, upload, and never call complete. Those objects are orphaned until a
  reaper is added (not yet built — see Known limitations in the README).
- Because the API re-fetches the object to checksum it, completion costs one
  extra round trip per upload. That is the price of not trusting the client.
- Local development requires real R2 credentials. Integration tests skip
  automatically when `OBJECT_STORE_*` is unset rather than failing.
- **The bucket needs a CORS policy for browser uploads to work at all.**
  Because the `PUT` goes browser → R2 rather than through our API, the
  browser enforces CORS on it. This is invisible to the test suite: Node's
  `fetch` ignores CORS, so the integration tests pass against a bucket whose
  policy would block every real user. Found only by driving an actual
  browser. See [troubleshooting](../troubleshooting.md) for the minimal
  policy; note it cannot be set with an Object Read & Write token.

## Security implications

- Presigned URLs are time-limited (15 minutes by default) and scoped to a
  single object key and content type.
- The R2 API token is scoped to Object Read & Write, not Admin. It currently
  applies to all buckets in the account; scoping it to a single bucket is a
  known tightening to make before any non-development use.
- Object keys are organisation-prefixed, and the prefix is server-derived, so
  the storage layout enforces the same tenant boundary as the database.
- Credentials live only in environment variables and are redacted from logs by
  `packages/observability`'s pino redact paths.

## Migration / rollback

Switching providers means changing `OBJECT_STORE_ENDPOINT` and credentials.
Existing objects would need copying; `artefacts.object_key` is provider-
relative, so no schema change is required.
