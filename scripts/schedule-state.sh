#!/usr/bin/env bash
#
# Flip an EventBridge Scheduler schedule's State without retyping its definition.
#
# `aws scheduler update-schedule` REPLACES the schedule rather than patching it,
# so anything you leave off the command line is silently dropped. That is a real
# trap here: sb-dev-mirror-sync carries Input {"mirror":true}, and a schedule
# that loses it stops being the display-only mirror and starts calling the
# poller's ordinary enqueue path instead. So read the definition back, change
# only State, and hand the rest to AWS exactly as it came.
#
# Usage:
#   scripts/schedule-state.sh sb-dev-poller ENABLED
#   scripts/schedule-state.sh sb-dev-mirror-sync DISABLED
#
# Requires: aws CLI v2 with credentials configured, and jq.
set -euo pipefail

NAME="${1:?usage: schedule-state.sh <schedule-name> <ENABLED|DISABLED>}"
STATE="${2:?usage: schedule-state.sh <schedule-name> <ENABLED|DISABLED>}"
REGION="${AWS_REGION:-us-east-1}"

case "$STATE" in
  ENABLED|DISABLED) ;;
  *) echo "state must be ENABLED or DISABLED, got: $STATE" >&2; exit 2 ;;
esac

# The shell's AWS_* vars are placeholders in this environment; the real
# credentials live in ~/.aws/credentials, so unset them for the call.
AWS="env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY aws"

CURRENT=$($AWS scheduler get-schedule --name "$NAME" --region "$REGION")

ARGS=$(echo "$CURRENT" | jq -r --arg s "$STATE" '
  [ "--name", .Name,
    "--state", $s,
    "--schedule-expression", .ScheduleExpression,
    "--schedule-expression-timezone", .ScheduleExpressionTimezone,
    "--group-name", .GroupName,
    "--description", .Description,
    "--flexible-time-window", (.FlexibleTimeWindow | tojson),
    "--target", (.Target | tojson) ] | @sh')

eval $AWS scheduler update-schedule --region "$REGION" "$ARGS" >/dev/null

# Read it back: the point of this script is that the Input survived.
$AWS scheduler get-schedule --name "$NAME" --region "$REGION" \
  --query '{name:Name,state:State,expression:ScheduleExpression,input:Target.Input}' \
  --output json
