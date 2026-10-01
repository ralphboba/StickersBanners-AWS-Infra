#!/usr/bin/env bash
# Let the artwork CloudFront distribution read the artwork bucket.
#
# This is the one change outside CDK, because the bucket is not ours to model:
# it was created by hand in eu-north-1 in November 2025 and the legacy system
# reads it too. CDK can put a distribution in front of a bucket it does not own,
# but it cannot edit that bucket's policy, so the OAC read grant goes here where
# the blast radius is visible.
#
# ADDITIVE ONLY. The existing `AllowPublicReadUploads` statement is what makes
# every historical artwork URL on years of OrderDesk orders resolve. This script
# never removes it. Closing public access is a separate decision for later, once
# every consumer reads through the distribution.
#
# Idempotent: re-running replaces the same Sid rather than stacking duplicates.
#
#   ./scripts/artwork-cdn-grant.sh                 # show what would change
#   ./scripts/artwork-cdn-grant.sh --apply         # write it
set -euo pipefail

BUCKET="${ARTWORK_BUCKET:-sticker-banner-large-file-uploads}"
STACK="${ARTWORK_CDN_STACK:-sb-artwork-cdn}"
REGION="${AWS_REGION:-us-east-1}"
SID="AllowArtworkCloudFrontRead"
APPLY=""
[ "${1:-}" = "--apply" ] && APPLY=1

AWS="env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY aws"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DIST_ARN="$($AWS cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtworkCdnArn'].OutputValue" --output text)"
if [ -z "$DIST_ARN" ] || [ "$DIST_ARN" = "None" ]; then
  echo "no ArtworkCdnArn output on $STACK — deploy the stack first" >&2
  exit 1
fi
echo "distribution: $DIST_ARN"
echo "bucket:       $BUCKET"

# A bucket with no policy at all is not an error; start from an empty document.
$AWS s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text \
  > "$WORK/current.json" 2>/dev/null \
  || echo '{"Version":"2012-10-17","Statements":[]}' > "$WORK/current.json"

python3 - "$WORK/current.json" "$WORK/next.json" "$DIST_ARN" "$BUCKET" "$SID" <<'PY'
import json, sys
cur_path, next_path, dist_arn, bucket, sid = sys.argv[1:6]
doc = json.load(open(cur_path))
stmts = doc.get("Statement") or doc.get("Statements") or []
doc["Statement"] = [s for s in stmts if s.get("Sid") != sid]
doc.pop("Statements", None)
doc.setdefault("Version", "2012-10-17")
doc["Statement"].append({
    "Sid": sid,
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": f"arn:aws:s3:::{bucket}/*",
    # Scoped to this one distribution: no other CloudFront account can use the
    # service principal to read the bucket.
    "Condition": {"StringEquals": {"AWS:SourceArn": dist_arn}},
})
json.dump(doc, open(next_path, "w"), indent=2)
kept = [s.get("Sid", "(no Sid)") for s in doc["Statement"] if s.get("Sid") != sid]
print("statements kept:", ", ".join(kept) or "(none)")
print("statement added:", sid)
PY

echo "--- policy that would be written ---"
cat "$WORK/next.json"

if [ -z "$APPLY" ]; then
  echo
  echo "dry run. re-run with --apply to write it."
  exit 0
fi

$AWS s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$WORK/next.json"
echo "applied."
