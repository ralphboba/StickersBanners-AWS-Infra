#!/usr/bin/env bash
#
# End the bounded live window. See docs/go-live.md.
#
# This is the whole reason arming is a deploy-time flag rather than an edit to
# three string literals: disarming is the same deploy with the flags left off,
# which is something you can still do correctly at the end of a long day.
#
# Usage: scripts/window-disarm.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== 1/3  stop the intake first ==="
# Before the redeploy, not after: otherwise a poll can land mid-deploy and
# enqueue an order whose containers are already being swapped underneath it.
scripts/schedule-state.sh sb-dev-poller DISABLED

echo
echo "=== 2/3  redeploy held ==="
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx cdk deploy sb-dev-compute sb-dev-ecs \
  --context env=dev --require-approval never

echo
echo "=== 3/3  mirror back on ==="
scripts/schedule-state.sh sb-dev-mirror-sync ENABLED

echo
echo "=== disarmed at $(TZ=America/New_York date '+%H:%M %Z') ==="
cat <<'NOTE'

Two things deliberately NOT undone:

  approval/link-secret + approval/portal-base stay in SSM. Every proof link
  already emailed is signed with that secret and customers answer on their own
  schedule; deleting it would kill every outstanding link. The page has no index
  and no login, so leaving it up costs nothing.

  Executions still RUNNING at disarm keep the armed task-definition revision and
  finish as armed. That is intended -- let them complete rather than killing an
  order halfway.

Still owed afterwards: inspect /AWS-TEST with src/services/ftp/ftp_inspect.py,
check every file against what the order data says it should be, and promote by
hand. Until someone does that, those orders are not printed.
NOTE
