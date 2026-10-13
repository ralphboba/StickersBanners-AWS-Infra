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
| `ftp` | ftpWorker + stpWorker (Drive) | ✅ ported |

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

## ftp (`src/services/ftp/`)

Same run contract (`ORDER_NAME` + `JOB`; env `FINISHED_BUCKET`, `JOBS_TABLE`,
`SB_ENV`). Downloads `finished/{order}/*`, transfers to the facility, records
`STEP#transfer`.

Preserved legacy logic (I):
- facility must be one of **GA/NJ/TX/NV/CA** (from `job.routing.facility`).
- **GA/NJ/TX/NV -> FTP** (`ftputil`), recursive upload to `/{facility}/{orderId}`;
  proof/invoice jpgs uploaded to FTP `/proof` first; optional `renameDict`
  proof renames (not-found / target-exists guarded, as legacy).
- **CA -> Google Drive** (`drive_helper.py`, ported from stpWorker): service
  account -> create order folder under `CA_DRIVE_ID` -> concurrent upload
  (4 workers) -> fails the task if any file failed.
- Credentials now come from SSM: `/sb/<env>/ftp/{host,user,password}`,
  `/sb/<env>/google/{service-account-json,ca-drive-id}` (new `ca-drive-id`
  param added to `lib/config/secrets.ts`).

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

## Stickers (Kai, 2026-10-12)

Round, oval and bumper stickers are made by the pipeline; **Custom Shape
Kiss-Cut (SKUDC) always goes to a person** (intake gate `special-product`, so
does any order with a kiss-cut line in it).

| Product | SKU | Size | Shape |
|---|---|---|---|
| Round | SKU-466/467/469/470 (2/3/4/5"), SKU-468 (size from order) | from the SKU | circle |
| Oval | SKU-471..479 (3x2 … 8x4") | from the SKU | oval |
| Bumper | SKUVS | the order's W x H, in **inches** | rectangle |
| Round on the bumper SKU | SKUVS named "Round Stickers" (S65535) | the order's W x H, in inches | circle |

- **Resolution**: smaller than 5x5 in (fits inside 5x5 and is not 5x5) →
  1000 dpi, anything else 650 (`stickerDpi`). Banners, adhesive and see-thru
  stay at 72.
- **Shape**: what the GA office does in Photoshop — canvas at the size, an
  ellipse the size of the canvas, the art clipped to it; outside is white (no
  ink, cut away). `resize/sticker.py`.
- **Fitted to the art**: the empty (white/transparent) margin around a
  round logo is cut so the logo fills the sticker, as the office does; art that
  is not round within 10% once the margin is gone is held (`bad-artwork`) for a
  person instead of being squashed. Ovals and bumpers keep white that is a
  logo's background, and lose a white frame round a filled design (its outline
  is >=80% ink) -- measured against 50 office files on 2026-10-12.
- **Colour**: CMYK, U.S. Web Coated (SWOP) v2 (`resize/profiles/`), converted
  as Photoshop does (relative colorimetric + black point compensation); CMYK
  art keeps its numbers. Proof images convert back through the profile. Vector art renders at least as dense as
  the print (`pdf_render_dpi(at_least_output=True)`); banners keep a flat 300.
- **Name**: the GA office's — `S67827 qty 25.tif`, or `S68045 - (1) qty 25.tif`
  when the order has more than one print item. No finishing.
- **Facility**: always GA, the whole order with it (OrderDesk's "Sticker back
  to GA" rule).
- **Cut sheet EPS** (stickers only, Kai 2026-10-13: TIF and EPS both):
  finish makes `S68142 qty 25.eps` next to `S68142 qty 25.tif`; the transfer
  sends both to the GA folder. `finish/sticker_sheet.py`, laid out as the GA
  office does (measured from 52 of its FineCut files; 49 identical, the other
  3 only by the office's hand-placed gaps):
  - short side across the roll (a 3x2 oval or a 10x3 bumper stands);
  - 0.5 in round the stickers and exactly 0.5 in between; as many a row as
    fit in 28 in, the row only as wide as its stickers (3 in rounds: 7, 25 in);
  - every row full (a short last row is filled up), all rows in one file,
    0.5 in between rows;
  - each row's four Mimaki register marks (spot colour "Mimaki Register
    Mark", 2 pt, 10 mm); FineCut's own tag on them is not written (not needed
    yet, Kai);
  - no printed box or cut line;
  - 2 pt bleed of the edge colour along the shape (taken 8 px inside, so a
    pale outermost pixel line in the customer's file does not print).
  The Linh comparison leaves `.eps` out on both sides (the office's is one
  row; ours is every row).
