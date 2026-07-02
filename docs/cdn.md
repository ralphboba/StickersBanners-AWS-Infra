# CDN (Week 11)

CloudFront in front of the private `dzi` bucket, so the proof viewer can load
Deep Zoom tiles fast and cheap.

## Why

A Deep Zoom viewer requests many small tiles per pan/zoom. Serving those from
S3 directly is slow and blocks the bucket from staying private. CloudFront
caches tiles at edge locations, keeps the bucket private, and adds HTTPS.

## Distribution (`sb-<env>-cdn`)

Defined in [`lib/stacks/cdn-stack.ts`](../lib/stacks/cdn-stack.ts).

| Setting | Value |
| --- | --- |
| Origin | `dzi` bucket via **Origin Access Control (OAC)** — modern replacement for OAI |
| Bucket access | private (block all public); only this distribution's ARN may `GetObject` |
| Viewer protocol | `REDIRECT_TO_HTTPS` |
| Cache policy | `CACHING_OPTIMIZED` (tiles are immutable → long TTL) |
| Response headers | `CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT` (browser tile viewer) |
| Price class | `PRICE_CLASS_100` (North America + Europe — cheapest) |
| Domain | default `*.cloudfront.net` (free cert); custom domain + ACM later |

## Avoiding the cross-stack cycle

OAC requires the **bucket policy to reference the distribution ARN**, while the
distribution references the bucket — a classic cross-stack cycle. Broken by:

1. `cdn-stack` references the `dzi` bucket by its **deterministic name**
   (`sb-<env>-dzi-<account>` + regional domain), not a CFN import — so the CDN
   stack has **no dependency** on the storage stack.
2. The OAC read statement is added to the bucket in the **storage stack**, using
   the distribution ARN passed as `dziDistributionArn`.

Result: `storage -> cdn` only. (Same family of fix as the Week 5 ECS execution
role.)

## Access model (privacy)

Default: the distribution is public; tiles are protected only by unguessable S3
keys (the viewer is handed the exact tile URLs). This is the simple, $0 path.
If proof artwork must be locked to authenticated users, upgrade to **signed
URLs / signed cookies** later (add a key group + signer) — no re-architecture
needed.

## Cost

CloudFront "Always Free": 1 TB data out + 10M requests/month → **$0** at this
volume. `PRICE_CLASS_100` also caps edge locations to the cheapest regions.

## Deploy

```bash
npx cdk deploy sb-dev-cdn sb-dev-storage --context env=dev
```

Deploy both: the CDN creates the distribution + OAC; storage attaches the read
policy. After deploy, the `DistributionDomainName` output is the base URL the
proof viewer points at (`https://<id>.cloudfront.net/<order>/...dzi`).
