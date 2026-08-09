#!/usr/bin/env bash
#
# Rotates Clerk and object-storage credentials in the local .env files.
#
# Reads each value straight from your terminal into the file. Nothing is
# echoed, nothing is written to shell history, and no value is printed back.
# Run it after issuing new keys in the Clerk and Cloudflare dashboards.
#
#   ./scripts/rotate-credentials.sh            # rotate everything
#   ./scripts/rotate-credentials.sh clerk      # Clerk only
#   ./scripts/rotate-credentials.sh storage    # object storage only

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-all}"

# Replaces KEY=... in a .env file, preserving every other line. Uses a temp
# file with the same permissions so the secret is never world-readable, even
# transiently.
set_env_var() {
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || { echo "  skip (missing): $file"; return 0; }

  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"

  if grep -q "^${key}=" "$file"; then
    # awk rather than sed: the value may contain / & and other sed metachars.
    awk -v k="$key" -v v="$value" \
      'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" > "$tmp"
  else
    cat "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  cat "$tmp" > "$file"
  rm -f "$tmp"
  echo "  updated ${key} in ${file}"
}

read_secret() {
  local prompt="$1" __var="$2" value
  printf '%s: ' "$prompt" >&2
  read -rs value
  printf '\n' >&2
  [ -n "$value" ] || { echo "empty value, aborting" >&2; exit 1; }
  printf -v "$__var" '%s' "$value"
}

if [ "$TARGET" = "all" ] || [ "$TARGET" = "clerk" ]; then
  echo "Clerk — dashboard.clerk.com -> your app -> API Keys"
  echo "Create new keys FIRST, then revoke the old secret key afterwards."
  read_secret "  New CLERK_SECRET_KEY (sk_...)" CLERK_SECRET
  read_secret "  New CLERK_PUBLISHABLE_KEY (pk_...)" CLERK_PUBLISHABLE

  case "$CLERK_SECRET" in sk_*) ;; *) echo "expected sk_ prefix, aborting" >&2; exit 1;; esac
  case "$CLERK_PUBLISHABLE" in pk_*) ;; *) echo "expected pk_ prefix, aborting" >&2; exit 1;; esac

  set_env_var apps/api/.env CLERK_SECRET_KEY "$CLERK_SECRET"
  set_env_var apps/api/.env CLERK_PUBLISHABLE_KEY "$CLERK_PUBLISHABLE"
  set_env_var apps/web/.env CLERK_SECRET_KEY "$CLERK_SECRET"
  set_env_var apps/web/.env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY "$CLERK_PUBLISHABLE"
  unset CLERK_SECRET CLERK_PUBLISHABLE
  echo
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "storage" ]; then
  echo "Object storage — R2 -> Manage API tokens -> Create Account API token"
  echo "Scope it to Object Read & Write, and to this bucket only."
  read_secret "  New OBJECT_STORE_ACCESS_KEY_ID" R2_ACCESS_KEY
  read_secret "  New OBJECT_STORE_SECRET_ACCESS_KEY" R2_SECRET_KEY

  set_env_var apps/api/.env OBJECT_STORE_ACCESS_KEY_ID "$R2_ACCESS_KEY"
  set_env_var apps/api/.env OBJECT_STORE_SECRET_ACCESS_KEY "$R2_SECRET_KEY"
  unset R2_ACCESS_KEY R2_SECRET_KEY
  echo
fi

echo "Done. Verify with: ./scripts/verify-credentials.sh"
echo "Then revoke the OLD keys in both dashboards — rotation is not complete"
echo "until the previous credentials stop working."
