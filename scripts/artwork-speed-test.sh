#!/usr/bin/env bash
# Same object, same machine, back to back: straight from S3 in Stockholm, then
# through the CloudFront distribution in front of it.
#
# Run this from the machine that is actually slow. Numbers taken inside AWS are
# meaningless here -- the whole question is what the office network does with a
# 120 ms transatlantic path, and AWS's backbone never sees that.
#
#   ./scripts/artwork-speed-test.sh
#   ./scripts/artwork-speed-test.sh "2026-09-14/1789397132791/DOD banner.pdf"
#
# Reads the first 32 MiB and throws it away, so nothing lands on disk and a
# 593 MB file does not have to come down in full to get an answer.
set -uo pipefail

BUCKET="sticker-banner-large-file-uploads"
REGION="eu-north-1"
CDN="dyahvbryasdy.cloudfront.net"
KEY="${1:-2026-09-14/1789397132791/DOD banner.pdf}"
MIB="${MIB:-32}"

ENC="$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$KEY" 2>/dev/null \
      || printf '%s' "$KEY" | sed 's/ /%20/g')"
BYTES=$((MIB*1024*1024))

run() {
  local label="$1" url="$2"
  local out
  out=$(curl -s -o /dev/null --max-time 600 -r 0-$((BYTES-1)) \
        -w '%{http_code} %{time_total} %{size_download}' "$url")
  read -r code secs size <<<"$out"
  if [ "$code" != "206" ] && [ "$code" != "200" ]; then
    printf '%-28s HTTP %s  <- failed\n' "$label" "$code"
    return
  fi
  awk -v l="$label" -v s="$secs" -v b="$size" 'BEGIN{
    mbps = (b*8)/s/1000000
    printf "%-28s %7.1f s   %8.1f Mbps\n", l, s, mbps
    # What that rate means for the biggest file seen in this bucket.
    t = (593*1024*1024*8)/(mbps*1000000)
    if (t > 3600) printf "%-28s   593 MB file: %.1f hours\n", "", t/3600
    else if (t > 60) printf "%-28s   593 MB file: %.1f minutes\n", "", t/60
    else printf "%-28s   593 MB file: %.0f seconds\n", "", t
  }'
}

echo "object: $KEY"
echo "reading first ${MIB} MiB from each, discarding"
echo
run "S3 direct (Stockholm)" "https://${BUCKET}.s3.${REGION}.amazonaws.com/${ENC}"
run "CloudFront (US edge)"  "https://${CDN}/${ENC}"
echo
echo "Second CloudFront run -- now that the edge has it cached:"
run "CloudFront (warm)"     "https://${CDN}/${ENC}"
