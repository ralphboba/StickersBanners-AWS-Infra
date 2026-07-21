# Image services (legacy logic ports)

The real pixel logic from the legacy `SBImageProcessor`, ported service by
service into the ECS Fargate containers (`src/services/<name>/`). Only the
infrastructure plumbing changed (local disk -> S3, Redis -> DynamoDB, FastAPI
server -> run-to-completion container); the image logic itself is preserved.

## Status

| Service | Legacy source | Status |
| --- | --- | --- |
| `resize` | worker/imageConverter + utils | ✅ ported |
| `finish` | finisher/{finisher,grommets,polePockets} | ⬜ next |
| `proof` (DZI) | dzi/dziConverter | ⬜ pending |
| `ftp` | ftpWorker + stpWorker (Drive) | ⬜ pending |

## resize (`src/services/resize/`)

Run contract (from Step Functions `EcsRunTask` container overrides):
- `ORDER_NAME` — e.g. `S42307`
- `JOB` — the cleaned job JSON (webhook `cleanOrder` shape)
- Task-definition env: `UPLOADS_BUCKET`, `PROCESSED_BUCKET`, `JOBS_TABLE` (set
  in `ecs-stack.ts` from deterministic names).

Per item: fetch artwork (URL or uploads bucket) -> convert -> upload
`s3://processed/{orderName}/{itemNo}v1.tif` -> `PK=ORDER#<n>, SK=STEP#resize`.

Preserved legacy logic:
- **Dimensions**: `in -> x72`, `ft -> x72x12` (72 DPI). Unit rule: `"in"` in the
  raw value or SKU in `SKUPB/SKUXB/SKU-543` -> inches, else feet.
- **Raster**: PIL LANCZOS resize, transparency flattened onto white, saved as
  TIFF 72dpi `tiff_lzw`.
- **PDF/EPS**: PyMuPDF render @300dpi, cropped to trimbox; single-page check.
- **AI**: header sniff — `%PDF` -> PDF path; `%!PS` -> Ghostscript (`gs` on
  Linux; the legacy called Windows `gswin64c.exe`).
- **PSD**: `psd_tools` composite.

Build & push (once per change):

```bash
cd src/services/resize
docker build -t sb-dev-resize .
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker tag sb-dev-resize:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/sb-dev-resize:latest
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/sb-dev-resize:latest
```

## Deliberately dropped from the legacy code (already replaced by AWS)

Manager thread-pool batching (Step Functions/ECS parallelism), BullMQ queues
(SQS/EventBridge), Redis worker-status/jobData (CloudWatch/DynamoDB), the
FastAPI/uvicorn HTTP wrappers (run-to-completion tasks), Express
sessions/auth (Cognito), local folder management (S3), and the OrderDesk
folder-id status map (dashboard is the single source of truth).
