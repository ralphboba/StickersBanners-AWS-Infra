#!/usr/bin/env bash
#
# Arm the bounded live window. See docs/go-live.md for why each of these steps
# exists and what it costs to get wrong.
#
# This is a go-live action. It needs Kai's explicit approval every time — the
# script existing is not the approval.
#
# What it turns on, in blast-radius order:
#   ORDERDESK_WRITES      real orders are moved and re-tagged
#   PRODUCTION_TRANSFER   print files are transferred (to /AWS-TEST, not to a
#                         facility folder -- the review path keeps a person in
#                         front of the one irreversible step)
#
# What it deliberately does NOT turn on:
#   ZENDESK_SENDS         stays held, so no customer is emailed and no inbox is
#                         touched. The ticket is still composed in full and
#                         logged -- real subject, real body, real signed
#                         approval link -- and Kai asked for each one to be read
#                         from the log rather than delivered anywhere. Linh's
#                         condition for the day was that customers must not get
#                         a second proof email when his program reprocesses the
#                         orders; holding the send satisfies that outright.
#                         (proofEmailRedirect exists for the case where you want
#                         real delivery to one inbox instead -- not this run.)
#
# Usage:
#   scripts/window-arm.sh              everything, window starts now
#   scripts/window-arm.sh --stage      steps 1-3 only, leaving the poller off
#   scripts/window-arm.sh --start      step 4 only, the poller
#
# Splitting it matters when the window starts at a set hour. Staging early is
# harmless: none of the armed switches do anything until the poller runs, since
# nothing else brings a real order into the pipeline. Doing the deploy under
# time pressure at the stroke of midnight is how a window starts broken.
set -euo pipefail

MODE="${1:-all}"
case "$MODE" in
  all|--stage|--start) ;;
  *) echo "usage: $0 [--stage|--start]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
AWS="env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY aws"

FOLDER_IDS='{"processing":"711436","manual":"711437","sales":"711438"}'
PORTAL_BASE="https://d1z2r5w66e9a93.cloudfront.net/proof.html"
REGION="${AWS_REGION:-us-east-1}"

if [ "$MODE" != "--start" ]; then
echo "=== 1/4  deploy with the trial flags ==="
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx cdk deploy sb-dev-compute sb-dev-ecs \
  --context env=dev --require-approval never \
  -c armOrderDeskWrites=true \
  -c armProductionTransfer=true \
  -c orderDeskFolderIds="$FOLDER_IDS" \
  -c ftpBasePath=/AWS-TEST

echo
echo "=== 2/4  seed the customer approval path ==="
# Still seeded even with the send held: the held path composes the real ticket
# and logs it, so the signed approval link in that log is only checkable if
# these two are present. They are what makes the held email worth reading.
# The secret is created only if absent, never rotated. Every approval link
# already emailed is signed with it, and customers answer on their own
# schedule -- a rotation here silently invalidates all of them.
if $AWS ssm get-parameter --name /sb/dev/approval/link-secret --region "$REGION" >/dev/null 2>&1; then
  echo "link-secret already present -- left alone"
else
  $AWS ssm put-parameter --name /sb/dev/approval/link-secret --type SecureString \
    --value "$(openssl rand -hex 32)" --region "$REGION" >/dev/null
  echo "link-secret created"
fi
# NOT --value: the AWS CLI treats an argument beginning with http:// or
# https:// as a URL to FETCH, so passing the portal address directly makes the
# CLI try to download it instead of storing it. Behind this environment's proxy
# that fails TLS verification, and with `set -e` it killed the arm midway --
# after the deploy had armed the switches but before the poller was enabled.
# Sending it as JSON keeps the value literal.
PB_JSON="$(mktemp)"
trap 'rm -f "$PB_JSON"' EXIT
printf '{"Name":"/sb/dev/approval/portal-base","Type":"String","Overwrite":true,"Value":"%s"}\n' \
  "$PORTAL_BASE" > "$PB_JSON"
$AWS ssm put-parameter --cli-input-json "file://$PB_JSON" --region "$REGION" >/dev/null
echo "portal-base -> $PORTAL_BASE"

echo
echo "=== 3/4  pause the mirror ==="
# The mirror calls OrderDesk ~10 times a minute and is the reason the poller
# has seen "rate limited: gave up after 5 attempts". It is display-only, so
# pausing it costs a stale dashboard for the window and nothing else.
scripts/schedule-state.sh sb-dev-mirror-sync DISABLED
fi

if [ "$MODE" = "--stage" ]; then
  echo
  echo "=== staged at $(TZ=America/New_York date '+%H:%M %Z') ==="
  echo "Switches are armed but the poller is OFF, so no real order can enter."
  echo "Start the window with: scripts/window-arm.sh --start"
  exit 0
fi

echo
echo "=== 4/4  start the intake ==="
scripts/schedule-state.sh sb-dev-poller ENABLED

echo
echo "=== armed at $(TZ=America/New_York date '+%H:%M %Z') ==="
echo "Disarm with scripts/window-disarm.sh. Until then, real orders are moving."
