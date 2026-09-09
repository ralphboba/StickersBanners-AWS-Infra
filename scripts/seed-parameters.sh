#!/usr/bin/env bash
#
# Seed SSM Parameter Store SecureString parameters for an environment.
#
# Reads real credential values from a LOCAL, git-ignored file
# (scripts/parameters.<env>.env) and writes them as encrypted SecureString
# parameters under /sb/<env>/<group>/<key>. Idempotent: re-running overwrites.
#
# Usage:
#   cp scripts/parameters.example.env scripts/parameters.dev.env
#   # edit scripts/parameters.dev.env with real values
#   scripts/seed-parameters.sh dev
#
# Requires: aws CLI v2 with credentials configured.
set -euo pipefail

ENV="${1:-dev}"
ENV_FILE="scripts/parameters.${ENV}.env"
PREFIX="/sb/${ENV}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy scripts/parameters.example.env and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

put() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    echo "  skip   $name (empty)"
    return
  fi
  aws ssm put-parameter \
    --name "$name" \
    --type SecureString \
    --value "$value" \
    --overwrite >/dev/null
  echo "  wrote  $name"
}

echo "Seeding SecureString parameters under $PREFIX ..."

put "$PREFIX/orderdesk/api-key"      "${ORDERDESK_API_KEY:-}"
put "$PREFIX/orderdesk/store-id"     "${ORDERDESK_STORE_ID:-}"

put "$PREFIX/zendesk/subdomain"      "${ZENDESK_SUBDOMAIN:-}"
put "$PREFIX/zendesk/email"          "${ZENDESK_EMAIL:-}"
put "$PREFIX/zendesk/api-token"      "${ZENDESK_API_TOKEN:-}"
# Ticket routing, from Linh. assignee-id is the agent the proof ticket lands on;
# field-id is the custom field that carries the order number.
put "$PREFIX/zendesk/assignee-id"    "${ZENDESK_ASSIGNEE_ID:-}"
put "$PREFIX/zendesk/field-id"       "${ZENDESK_FIELD_ID:-}"

# Customer proof approval links. Seeding BOTH of these switches the proof-ready
# email from Linh's portal to our own approval page; leaving either empty keeps
# the legacy portal. See docs/customer-approval.md before seeding them.
put "$PREFIX/approval/link-secret"   "${APPROVAL_LINK_SECRET:-}"
put "$PREFIX/approval/portal-base"   "${APPROVAL_PORTAL_BASE:-}"

put "$PREFIX/ftp/host"               "${FTP_HOST:-}"
put "$PREFIX/ftp/user"               "${FTP_USER:-}"
put "$PREFIX/ftp/password"           "${FTP_PASSWORD:-}"

put "$PREFIX/discord/webhook-url"    "${DISCORD_WEBHOOK_URL:-}"

put "$PREFIX/gmail/user"             "${GMAIL_USER:-}"
put "$PREFIX/gmail/app-password"     "${GMAIL_APP_PASSWORD:-}"

if [[ -n "${GOOGLE_SERVICE_ACCOUNT_JSON_FILE:-}" ]]; then
  if [[ -f "$GOOGLE_SERVICE_ACCOUNT_JSON_FILE" ]]; then
    put "$PREFIX/google/service-account-json" "$(cat "$GOOGLE_SERVICE_ACCOUNT_JSON_FILE")"
  else
    echo "  WARN   GOOGLE_SERVICE_ACCOUNT_JSON_FILE set but file not found: $GOOGLE_SERVICE_ACCOUNT_JSON_FILE" >&2
  fi
fi

echo "Done. Verify with:  aws ssm get-parameters-by-path --path $PREFIX --recursive --query 'Parameters[].Name'"
