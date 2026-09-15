# Customer artwork CDN

Why downloading a customer's artwork is slow, what actually causes it, and the
change that fixes it without moving 2.95 TB or breaking years of links.

## The report

> is the cdn for file hosting working fine? looks like the speed's been
> throttled heavily this afternoon when downloading. im getting barely 0.1mbps
> for download for both my bot and on my work pc — Linh, 2026-09-15

Two things in that sentence are worth separating. There is no CDN — the files
are served straight from S3. And nothing is throttled.

## Where the files actually are

| | |
| --- | --- |
| Bucket | `sticker-banner-large-file-uploads` |
| Region | **eu-north-1 (Stockholm)** |
| Size | 2.95 TB across 236,360 objects |
| Largest recent uploads | 593 MB, 566 MB, 480 MB |
| Fronted by | nothing — `Server: AmazonS3` on the wire |
| Access | public read (`AllowPublicReadUploads`, `Principal: "*"`) |
| Owner | our own account, `025857592188` |

Two other hosts carry artwork as well: a Supabase bucket for DC prints, and
`64.57.252.249:8080` (plain HTTP, no TLS) for legacy orders.

### The region looks like an accident

Every other bucket in the account is us-east-1, including one created two weeks
earlier. There are no tags, no policy and no other European resource that would
explain the choice, and eu-north-1 storage is not meaningfully cheaper than
us-east-1, so there was no saving to be had. The most likely explanation is a
console region selector left on the wrong value on 2025-11-14. CloudTrail keeps
90 days of management events, so at ten months old the creating identity is not
recoverable.

## What the slowness actually is

Measured from us-east-1, reading the first 32 MiB of a real 593 MB object:

| Origin | 1 stream | 8 parallel ranges |
| --- | --- | --- |
| eu-north-1 (S3) | 95.4 Mbps | 133.8 Mbps |
| us-east-1 (S3) | 219.3 Mbps | 331.6 Mbps |

The region costs about **2.3x**. That is real and worth removing — but it is not
what produces 0.1 Mbps. The same Stockholm path measures 95 Mbps here.

The missing factor is **packet loss on a long path**. Single-stream TCP
throughput falls off as roughly

```
    throughput  ~  MSS / (RTT * sqrt(loss))
```

The measurements above run over AWS's backbone, where loss is negligible, which
is why distance alone only costs 2.3x. A US office reaching Stockholm crosses
public transit at ~120 ms RTT, and at that latency one or two percent of loss is
enough to collapse a single stream into the hundreds of kbps. That is the
1000x, and it lives in the network between the office and Sweden — not in S3,
and not in anything either program is doing.

Then the file sizes turn a network annoyance into a business problem. **593 MB
at 0.1 Mbps is thirteen hours.** At 95 Mbps it is fifty seconds.

## Why CloudFront fixes it — and why caching is not the reason

Each artwork file is fetched about once, so the cache hit rate will be low.
Recommending a CDN "so it gets cached" would be the wrong reason. The win is the
shape of the path:

- the client's TCP connection terminates at a **US edge**, so RTT drops from
  ~120 ms to ~15 ms over its own ISP, where a little loss barely matters;
- the **edge-to-Stockholm leg runs on AWS's backbone** — the 95-134 Mbps path
  measured above — instead of public transit.

A 1000x problem becomes the 2.3x one, and no data moves.

## Why not just move the bucket

An S3 bucket's region is fixed at creation; there is no move. Recreating it in
us-east-1 means a new bucket, and bucket names are globally unique, so keeping
the name means deleting the original first. The artwork URLs on years of
OrderDesk orders are `https://sticker-banner-large-file-uploads.s3.eu-north-1.
amazonaws.com/...`, so deleting it breaks the artwork on every historical order,
including any Linh reprocesses. Copying 2.95 TB out of eu-north-1 also costs
roughly $60 one-time plus duplicated storage.

Pointing **new** uploads at a us-east-1 bucket is the separate, cheap half of
this: no backfill, no double storage, old links untouched, and new orders — the
ones whose speed matters — stop crossing the Atlantic at all. The upload path is
not in this repository.

## The change

`lib/stacks/artwork-cdn-stack.ts`, deployed as the account-level stack
`sb-artwork-cdn` (the bucket is shared with the legacy system, so this is not
env-scoped). The stack never owns, moves or locks the bucket — it only puts a
distribution in front of it.

```bash
npx cdk deploy sb-artwork-cdn --context env=dev
./scripts/artwork-cdn-grant.sh            # dry run: prints the policy diff
./scripts/artwork-cdn-grant.sh --apply    # additive OAC read grant
```

The origin is the **regional** domain `...s3.eu-north-1.amazonaws.com`. The bare
`s3.amazonaws.com` form resolves through us-east-1 and redirects, and CloudFront
does not follow origin redirects.

Consumers then swap the hostname:

```
https://sticker-banner-large-file-uploads.s3.eu-north-1.amazonaws.com/<key>
https://<distribution>.cloudfront.net/<key>
```

A hostname rewrite at download time covers historical URLs too, without
rewriting anything stored in OrderDesk.

### Cost

CloudFront's always-free tier is 1 TB out and 10M requests a month. The bucket
has accumulated ~295 GB/month; if every object is downloaded once that is
~295 GB/month out, comfortably inside it. S3-to-CloudFront origin fetches are
not charged. Expected cost: **$0**.

## Deliberately phased

The bucket is public-read today, and that is exactly what makes the historical
URLs resolve. **This change does not touch it.** Origin Access Control is
configured so CloudFront signs its origin requests, but OAC does not require a
private bucket — the grant script only *adds* a statement. Direct S3 URLs keep
working.

That leaves a real finding on the table: **236,360 customer artwork files are
publicly readable to anyone with the URL**, and the keys are
`<date>/<epoch-ms>/<filename>`, which is not especially hard to walk. Closing
public access is the right end state, and it belongs in its own change, after
every consumer reads through the distribution. Bundling it here would trade a
speed fix for broken artwork on every old order.

## How to verify after deploying

Nothing in this repository can measure the fix: the build environment reaches
S3 but is blocked from CloudFront, and the numbers that matter are from Linh's
network, not from inside AWS. The test is his:

```bash
time curl -o /dev/null "https://sticker-banner-large-file-uploads.s3.eu-north-1.amazonaws.com/<key>"
time curl -o /dev/null "https://<distribution>.cloudfront.net/<key>"
```

Same object, same machine, back to back. If the second is not dramatically
faster, the diagnosis above is wrong and the next suspect is his local network
rather than the path to Stockholm.
