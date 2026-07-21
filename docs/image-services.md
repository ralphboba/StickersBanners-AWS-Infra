# Image services (legacy logic ports)

The real pixel logic from the legacy `SBImageProcessor`, ported service by
service into the ECS Fargate containers (`src/services/<name>/`). Only the
infrastructure plumbing changed (local disk -> S3, Redis -> DynamoDB, FastAPI
server -> run-to-completion container); the image logic itself is preserved.

## Status

| Service | Legacy source | Status |
| --- | --- | --- |
| `resize` | worker/imageConverter + utils | ✅ ported |
| `finish` | finisher/{finisher,grommets,polePockets} + FINISHINGCONFIG | ✅ ported |
| `proof` (DZI) | dzi/dziConverter | ✅ ported |
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

## finish (`src/services/finish/`)

Same run contract (`ORDER_NAME` + `JOB`; env `PROCESSED_BUCKET`,
`FINISHED_BUCKET`, `JOBS_TABLE`). Reads `processed/{order}/{itemNo}v1.tif`,
writes proofs + finals to the finished bucket, records `STEP#finish`.

Preserved legacy logic:
- **D. Grommets** (`grommets.py`, verbatim port): corner inset `0.75*72 = 54px`;
  each mark = three concentric ellipses (black border r7 / white outline r6 /
  red fill r4); sides with >2 grommets spaced `(len - 2*inset)/(count-1)`;
  corner dedupe; saved @72dpi.
- **E. Pole pockets** (`pole_pockets.py`): pocket `4.5in*72 = 324px`; canvas
  grows per mode (PPTB +2x, PPTO/PPBO +1x height, PPL/PPR +1x, PPS +2x width,
  RET fixed 80in height + 3in spacing); white canvas, black 2px fold stroke,
  artwork pasted at offset; TIFF 72dpi lzw.
- **F. Order of operations** (`main.py`): proof thumbnail (300px, CMYK->RGB) ->
  plain copy when no finishing -> grommets (output feeds next step) -> pole
  pockets -> rename `{orderId}-{itemNo} {descSuf}[ qty N].tif`.
- **G. FINISHINGCONFIG mapping** (`finishing_config.py`): OrderDesk text ->
  finishing object ("Hem Grommets" -> 4-side grommets, "Pole Pocket Top Only"
  -> PPTO, "Hem Only"/"Cut Only" -> desc suffix), `NOFINISHSKU` skip list.

## proof (`src/services/proof/`)

Same run contract (`ORDER_NAME` + `JOB`; env `PROCESSED_BUCKET`, `DZI_BUCKET`,
`JOBS_TABLE`). Reads `processed/{order}/{itemNo}v1.tif`, writes the deep-zoom
tree to `dzi/{order}/...` (served by the Week 11 CloudFront distribution),
records `STEP#proof`.

Preserved legacy logic (H):
- **DZI tiling**: pyvips `dzsave` — `tile_size=256, overlap=1, suffix=.jpg,
  layout=dz` — full-resolution zooming in the proof viewer.
- **Derivatives**: thumbnail 300px / bleed 600px / review 800px / proof 500px,
  all CMYK->RGB with LANCZOS.
- Dockerfile installs `libvips` for pyvips.

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
