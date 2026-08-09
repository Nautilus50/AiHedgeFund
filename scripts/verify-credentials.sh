#!/usr/bin/env bash
#
# Checks that the credentials currently in apps/api/.env actually work.
# Prints pass/fail only — never a credential value.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== Object storage =="
if node -e '
process.loadEnvFile("apps/api/.env");
const { S3Client, ListObjectsV2Command } = require("./apps/api/node_modules/@aws-sdk/client-s3");
const need = ["OBJECT_STORE_ENDPOINT","OBJECT_STORE_BUCKET","OBJECT_STORE_ACCESS_KEY_ID","OBJECT_STORE_SECRET_ACCESS_KEY"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error("  missing: " + missing.join(", ")); process.exit(1); }
const c = new S3Client({
  region: process.env.OBJECT_STORE_REGION || "auto",
  endpoint: process.env.OBJECT_STORE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORE_SECRET_ACCESS_KEY,
  },
});
c.send(new ListObjectsV2Command({ Bucket: process.env.OBJECT_STORE_BUCKET }))
 .then((r) => { console.log("  OK — bucket reachable, " + (r.KeyCount ?? 0) + " object(s)"); })
 .catch((e) => { console.error("  FAIL — " + e.name + ": " + e.message); process.exit(1); });
' 2>&1; then :; else fail=1; fi

echo "== Object storage CORS =="
# A missing CORS policy breaks browser uploads while every test still passes,
# because Node's fetch ignores CORS. Probe it with a real preflight instead.
if node -e '
process.loadEnvFile("apps/api/.env");
const origin = process.env.WEB_ORIGIN || "http://localhost:3000";
const endpoint = process.env.OBJECT_STORE_ENDPOINT, bucket = process.env.OBJECT_STORE_BUCKET;
if (!endpoint || !bucket) { console.error("  skipped — storage not configured"); process.exit(0); }
const host = new URL(endpoint).host;
fetch(`https://${bucket}.${host}/cors-probe`, {
  method: "OPTIONS",
  headers: {
    Origin: origin,
    "Access-Control-Request-Method": "PUT",
    "Access-Control-Request-Headers": "content-type",
  },
}).then((r) => {
  const allow = r.headers.get("access-control-allow-origin");
  if (allow) { console.log(`  OK — preflight allows ${origin} (allow-origin: ${allow})`); }
  else {
    console.error(`  FAIL — no access-control-allow-origin for ${origin} (HTTP ${r.status}).`);
    console.error("         Browser uploads will fail with \"Failed to fetch\".");
    console.error("         See docs/local-setup.md -> Bucket CORS policy.");
    process.exit(1);
  }
}).catch((e) => { console.error("  FAIL — " + e.message); process.exit(1); });
' 2>&1; then :; else fail=1; fi

echo "== Clerk =="
if node -e '
process.loadEnvFile("apps/api/.env");
const key = process.env.CLERK_SECRET_KEY;
if (!key) { console.error("  missing: CLERK_SECRET_KEY"); process.exit(1); }
fetch("https://api.clerk.com/v1/jwks", { headers: { Authorization: "Bearer " + key } })
  .then((r) => {
    if (r.ok) { console.log("  OK — secret key accepted (HTTP " + r.status + ")"); }
    else { console.error("  FAIL — HTTP " + r.status + " (revoked or wrong key?)"); process.exit(1); }
  })
  .catch((e) => { console.error("  FAIL — " + e.message); process.exit(1); });
' 2>&1; then :; else fail=1; fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All credentials verified."
else
  echo "One or more checks failed — see above."
fi
exit "$fail"
