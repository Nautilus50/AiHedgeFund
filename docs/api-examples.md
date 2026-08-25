# API examples

Base URL `http://localhost:4000`. Every `/v1` route requires an
organisation-scoped Clerk session token:

```
Authorization: Bearer <clerk session jwt>
```

A token with no `org_id` claim is rejected — ARF-OS is organisation-scoped by
design. Mutating routes additionally require an `Idempotency-Key` header.

Errors follow RFC 9457 problem-details (CLAUDE.md 7.5):

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "Requires one of: COMMITTEE_MEMBER, ADMIN.",
  "instance": "/v1/strategy-versions/.../decisions",
  "code": "ROLE_NOT_PERMITTED"
}
```

## Health

```bash
curl http://localhost:4000/health
```

```json
{ "status": "ok", "service": "arf-os-api", "timestamp": "2026-08-08T16:10:32.314Z" }
```

## Who am I

```bash
curl http://localhost:4000/v1/me -H "Authorization: Bearer $TOKEN"
```

```json
{ "userId": "019fe…", "organisationId": "019fe…", "role": "ADMIN" }
```

## Campaigns

```bash
curl -X POST http://localhost:4000/v1/campaigns \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"BTC mean reversion","brief":"Test funding-driven reversion.","allowedMarkets":["crypto"]}'
```

Listing is cursor-paginated:

```bash
curl "http://localhost:4000/v1/campaigns?limit=20" -H "Authorization: Bearer $TOKEN"
```

```json
{ "items": [ { "id": "019fe…", "name": "BTC mean reversion", "status": "DRAFT" } ],
  "nextCursor": "MjAyNi0wOC0wOFQxNjoxMDozMi4zMTRafDAxOWZl" }
```

Pass `nextCursor` back as `?cursor=` for the next page. Absent means the end.

## Strategies and versions

```bash
# Create a strategy (also creates version 1)
curl -X POST http://localhost:4000/v1/strategies \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"campaignId":"019fe…","name":"RSI reversion"}'

# Create a child version — the parent is never mutated
curl -X POST http://localhost:4000/v1/strategies/$STRATEGY_ID/versions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"parentVersionId":"019fe…","changeCategory":"PARAMETER_CHANGE",
       "changedFields":["risk.sizePercent"],"changeReason":"Reduce size after drawdown review."}'
```

### Store the SDL

```bash
curl -X PUT http://localhost:4000/v1/strategy-versions/$VERSION_ID/definition \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @strategy-definition.json
```

An invalid SDL returns 422 with per-field errors and never reaches the
database:

```json
{ "status": 422, "code": "INVALID_DEFINITION",
  "validationErrors": [{ "path": ["execution","pyramiding"], "message": "Invalid literal value, expected 0" }] }
```

### Store a Pine revision

```bash
curl -X PUT http://localhost:4000/v1/strategy-versions/$VERSION_ID/pine \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"//@version=6\nstrategy(\"RSI\", ...)","manifest":{"symbol":"BYBIT:BTCUSDT.P"}}'
```

Returns `sourceHash` and `manifestHash`. Source hashing is plain SHA-256 over
the raw text — reformatting produces a different revision, deliberately.

## TradingView verification

```bash
# 1. Create the verification task
curl -X POST http://localhost:4000/v1/verifications \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"strategyVersionId":"019fe…","requiredSymbol":"BYBIT:BTCUSDT.P","requiredTimeframe":"60"}'

# 2. Ask for a presigned upload URL
curl -X POST http://localhost:4000/v1/verifications/$VERIFICATION_ID/uploads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"LIST_OF_TRADES"}'
# -> { "uploadUrl": "https://...", "objectKey": "orgs/...", "expiresInSeconds": 900 }

# 3. Upload the bytes directly to storage (not through the API)
curl -X PUT "$UPLOAD_URL" -H "Content-Type: text/csv" --data-binary @list-of-trades.csv

# 4. Complete: server re-fetches, checksums, persists, parses.
#    Naming the run is what starts normalisation (see Backtest runs below);
#    omit it and the upload is stored as evidence but nothing is queued.
curl -X POST http://localhost:4000/v1/verifications/$VERIFICATION_ID/uploads/complete \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"kind\":\"LIST_OF_TRADES\",\"objectKey\":\"$OBJECT_KEY\",\"backtestRunId\":\"$RUN_ID\"}"
# -> { "artefactId": "...", "reportUploadId": "...", "parseOutcome": {...},
#      "normalisationQueued": true }
```

The object key is never trusted for ownership — organisation, campaign, and
strategy are derived server-side from the verification row. `backtestRunId`
is likewise re-checked against the caller's organisation and against the
verification's strategy version before it reaches an outbox payload.

## Backtest runs

A run records what a result was produced under. Every field is required: none
can be recovered from a TradingView export, and defaulting one would record
an assumption the researcher never made.

```bash
curl -X POST http://localhost:4000/v1/backtest-runs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"strategyVersionId":"019fe…",
       "runnerType":"TRADINGVIEW",
       "runnerVersion":"tv-2026.08",
       "verificationId":"019fe…",
       "symbol":"BYBIT:BTCUSDT.P",
       "timeframe":"60",
       "segmentKind":"IN_SAMPLE",
       "fromTs":"2024-01-01T00:00:00Z",
       "toTs":"2024-06-30T23:59:59Z",
       "costModel":{"commissionPct":0.055,"slippageTicks":1},
       "initialCapital":"10000",
       "sourceHash":"e3b0c44…"}'
# -> { "backtestRunId": "019fe…" }

curl http://localhost:4000/v1/backtest-runs/$RUN_ID -H "Authorization: Bearer $TOKEN"
```

`initialCapital` is a string, not a JSON number: capital is decimal money and
JSON numbers are IEEE-754 doubles. `verificationId` is optional, but when
given it must belong to the same strategy version as the run — otherwise
parity would end up comparing two different strategies.

Completing a List of Trades upload with this run's id starts the chain:
ledger → equity and drawdown → metric snapshots → parity report.

## Committee decision

```bash
curl -X POST http://localhost:4000/v1/strategy-versions/$VERSION_ID/decisions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"decision":"PAPER_APPROVED",
       "reasonCodes":["OOS_POSITIVE","PARITY_PASS"],
       "evidenceIds":["019fe…"],
       "rejectionCase":"Only 118 closed trades; edge concentrated in Q1.",
       "positiveCase":"Survived neighbouring parameters and cost stress."}'
```

Both `rejectionCase` and `positiveCase` are mandatory for every decision,
including approvals (spec 7.9 — the judge must state both).

The decision drives the workflow transition atomically. Policy rejections
return 409:

```json
{ "status": 409, "code": "CREATOR_CANNOT_APPROVE_OWN_VERSION",
  "detail": "The actor who created this strategy version cannot approve it (CLAUDE.md 3.4)." }
```

## Algo library

Catalogue an algo, pin a release to a `PAPER_APPROVED` strategy version, record
the evidence, and publish it (ADR 0015). All four require `OPERATOR` or `ADMIN`.

```bash
ALGO_ID=$(curl -s -X POST http://localhost:4000/v1/algos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"slug":"momentum-btc","name":"Momentum BTC","tagline":"Trend continuation on BTC 1h.",
       "marketCategory":"CRYPTO","symbol":"BTCUSD","timeframe":"60"}' | jq -r .algoId)

RELEASE_ID=$(curl -s -X POST http://localhost:4000/v1/algos/$ALGO_ID/releases \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"strategyVersionId\":\"$VERSION_ID\",\"changelog\":\"First release.\"}" | jq -r .releaseId)

curl -X POST http://localhost:4000/v1/algo-releases/$RELEASE_ID/stats \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"backtestRunId\":\"$RUN_ID\",\"scope\":\"OUT_OF_SAMPLE\"}"

curl -X POST http://localhost:4000/v1/algos/$ALGO_ID/publish \
  -H "Authorization: Bearer $TOKEN"
```

A release from a version that has not reached `PAPER_APPROVED` is refused:

```json
{ "status": 422, "code": "NOT_PAPER_APPROVED",
  "detail": "A release requires a PAPER_APPROVED strategy version (this one is PINE_DEVELOPMENT)." }
```

Reading the catalogue and the source. The source comes from the release's
immutable Pine revision, and the read writes an `ALGO_SOURCE_READ` audit event:

```bash
curl "http://localhost:4000/v1/algos?status=PUBLISHED" -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/v1/algos/momentum-btc -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/v1/algos/momentum-btc/source -H "Authorization: Bearer $TOKEN"
```

## Audit timeline

```bash
curl http://localhost:4000/v1/strategy-versions/$VERSION_ID/audit \
  -H "Authorization: Bearer $TOKEN"
```

## Idempotency

Replaying a key with an identical body returns the original response and
`200` instead of `201`. Reusing it with a different body is a conflict:

```json
{ "status": 409, "title": "Idempotency-Key conflict",
  "detail": "This key was already used for a different request body." }
```

Comparison uses a canonical fingerprint, so JSON key order does not matter.
