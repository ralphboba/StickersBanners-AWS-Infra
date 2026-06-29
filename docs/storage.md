# Storage (Week 3)

S3 buckets that replace the legacy single-PC local disk (C:/D:/E:).

## Buckets

Defined in [`lib/stacks/storage-stack.ts`](../lib/stacks/storage-stack.ts)
(`sb-<env>-storage`). Physical names are `sb-<env>-<key>-<account>` for global
uniqueness.

| Bucket (`key`) | Holds | Lambda | ECS | Notes |
| --- | --- | --- | --- | --- |
| `uploads` | raw customer artwork (presigned browser PUT) | read/write | read | CORS enabled, IA after 90d |
| `processed` | resized / normalized images | read | read/write | IA after 90d |
| `finished` | print-ready output files | read | read/write | |
| `dzi` | Deep Zoom tiles for the proof viewer | read | read/write | CloudFront origin (later) |
| `invoices` | generated PDF invoices | read/write | read | |

Access split mirrors the architecture: **Lambda** owns the API surface
(presigned uploads, invoice generation), **ECS Fargate** does the image
processing (reads uploads, writes processed/finished/dzi).

## Security posture (all buckets)

- **SSE-S3** server-side encryption (AES256, free — no KMS charge).
- **Block all public access** (ACLs + policies).
- **Enforce TLS**: a bucket policy denies any non-HTTPS request
  (`aws:SecureTransport = false`).
- **Multipart hygiene**: incomplete multipart uploads are aborted after 7 days
  so you never pay for abandoned partial uploads.

## Cost

Empty buckets are **$0**. The S3 free tier covers 5 GB storage, 20k GET, and
2k PUT for the first 12 months. The only cost driver is stored bytes once the
pipeline runs; `uploads` and `processed` (intermediate artifacts) transition to
**Infrequent Access** after 90 days to keep long-term cost down.

## Removal policy

| env | removal | auto-delete objects |
| --- | --- | --- |
| dev | `DESTROY` | yes (bucket emptied on `cdk destroy`) |
| prod | `RETAIN` | no (data survives stack deletion) |

## CORS

The `uploads` bucket allows `PUT`/`GET`/`HEAD` from any origin (`*`) so the
browser can upload directly with a presigned URL. Tighten `allowedOrigins` to
the real web origin once the frontend domain exists.

## Deploy

```bash
npx cdk diff   sb-dev-storage --context env=dev
npx cdk deploy sb-dev-storage --context env=dev
```

This stack is **free to deploy** (empty buckets). It depends on
`sb-<env>-iam` for the role grants.
